import { MutationSummary } from './mutation-summary';

if (__DEV__) {
  // console.log(MutationSummary);
  // console.log(MutationSummary.NodeMap);
  console.log("TreeMirror loaded in __dev__ mode")
}

var TreeMirror = (function () {
    function TreeMirror(root, delegate) {
        this.root = root;
        this.delegate = delegate;
        this.idMap = {};
    }
    TreeMirror.prototype.initialize = function (rootId, children) {
        this.idMap[rootId] = this.root;

        for (var i = 0; i < children.length; i++)
            this.deserializeNode(children[i], this.root);
    };

    TreeMirror.prototype.applyChanged = function (removed, addedOrMoved, attributes, text) {
        var _this = this;
        // NOTE: Applying the changes can result in an attempting to add a child
        // to a parent which is presently an ancestor of the parent. This can occur
        // based on random ordering of moves. The way we handle this is to first
        // remove all changed nodes from their parents, then apply.
        addedOrMoved.forEach(function (data) {
            var node = _this.deserializeNode(data);
            var parent = _this.deserializeNode(data.parentNode);
            var previous = _this.deserializeNode(data.previousSibling);

            if (node.contains(parent) === false &&
                node instanceof HTMLElement === true &&
                parent instanceof HTMLElement === true &&
                node.parentNode) {
                  node.parentNode.removeChild(node);
            }
        });

        removed.forEach(function (data) {
            var node = _this.deserializeNode(data);
            if (node.parentNode)
                node.parentNode.removeChild(node);
        });

        addedOrMoved.forEach(function (data) {
            var node = _this.deserializeNode(data);
            var parent = _this.deserializeNode(data.parentNode);
            var previous = _this.deserializeNode(data.previousSibling);

            try {
              // The node might be a document element which has a parent reference
              // to the last node in the idMap. In this case we will see the error
              // above (see NOTE)
              if (!node.contains(parent) && 
                  (node instanceof HTMLElement === true) &&
              // 21.3.2017: In some cases the idMap reports that the parent of the element is for example
              // html comment. In this case we obviously don't want to apply the move so we check
              // here that it is
                  (parent instanceof HTMLElement === true)
              ) {
                parent.insertBefore(node, previous ? previous.nextSibling : parent.firstChild);
              }
              // 21.3.2017: Handle <html> elements as special case in case we the tree is trying
              // to remove it, we add back to root
              else if (
                node instanceof HTMLElement &&
                node.nodeName === "HTML" &&
                _this.root instanceof HTMLDocument &&
                _this.root.contains(node) === false
              ) {
                _this.root.appendChild(node);
              }
            }
            catch(e) {
              // In some cases it seems that MutationSummary determines the parent
              // of a node incorrectly. Example: <meta> element has parent #document
              // and previousSibling is <html>. When this occurs we receive an error
              // that says 'Only one element is allowed on #document'
              // We probably want to append the node to the sibling
              if (parent instanceof HTMLDocument &&
                  previous instanceof HTMLElement &&
                  parent.contains(previous)) {
                if (previous.firstChild)
                  previous.insertBefore(node, previous.firstChild)
                else
                  previous.appendChild(node);
              }

              // Might still fail but we should call applyChanged inside try...catch
              // anyway
              if (_this.debug) {
                console.log(e)
              }
            }
        });

        attributes.forEach(function (data) {
            var node = _this.deserializeNode(data);
            Object.keys(data.attributes).forEach(function (attrName) {
                var newVal = data.attributes[attrName];
                if (newVal === null) {
                    node.removeAttribute(attrName);
                } else {
                    try {
                      if (!_this.delegate || !_this.delegate.setAttribute || !_this.delegate.setAttribute(node, attrName, newVal)) {
                        node.setAttribute(attrName, newVal);
                      }
                    } catch(e) {
                      // Debug node.setAttribute here
                    }
                }
            });
        });

        text.forEach(function (data) {
            var node = _this.deserializeNode(data);
            node.textContent = data.textContent;
        });

        removed.forEach(function (node) {
            delete _this.idMap[node.id];
        });
    };

    TreeMirror.prototype.deserializeNode = function (nodeData, parent) {
        var _this = this;
        if (nodeData === null)
            return null;

        var node = this.idMap[nodeData.id];
        if (node)
            return node;

        var doc = this.root.ownerDocument;
        if (doc === null)
            doc = this.root;

        switch (nodeData.nodeType) {
            case Node.COMMENT_NODE:
                node = doc.createComment(nodeData.textContent);
                break;

            case Node.TEXT_NODE:
                node = doc.createTextNode(nodeData.textContent);
                break;

            case Node.DOCUMENT_TYPE_NODE:
                node = doc.implementation.createDocumentType(nodeData.name, nodeData.publicId, nodeData.systemId);
                break;

            case Node.ELEMENT_NODE:
                if (this.delegate && this.delegate.createElement)
                    node = this.delegate.createElement(nodeData.tagName);
                if (!node)
                    node = doc.createElement(nodeData.tagName);

                Object.keys(nodeData.attributes).forEach(function (name) {
                	try {
	                    if (!_this.delegate || !_this.delegate.setAttribute || !_this.delegate.setAttribute(node, name, nodeData.attributes[name])) {
	                        node.setAttribute(name, nodeData.attributes[name]);
	                    }
                    } catch (e) {
                    	// Debug here if needed
                    }
                });

                break;
        }

        if (!node)
          throw "ouch";

        this.idMap[nodeData.id] = node;

        if (parent)
            parent.appendChild(node);

        if (nodeData.childNodes) {
            for (var i = 0; i < nodeData.childNodes.length; i++)
                this.deserializeNode(nodeData.childNodes[i], node);
        }

        return node;
    };
    return TreeMirror;
})();

var TreeMirrorClient = (function () {

    function TreeMirrorClient(target, mirror, testingQueries) {
        var _this = this;
        this.target = target;
        this.mirror = mirror;
        this.nextId = 1;
        this.knownNodes = new MutationSummary.NodeMap();

        if (typeof this.mirror == "undefined") {
          this.mirror = _this.getDefaultMirror();
        }

        var rootId = this.serializeNode(target).id;
        var children = [];
        for (var child = target.firstChild; child; child = child.nextSibling)
            children.push(this.serializeNode(child, true));

        this.mirror.initialize(rootId, children);

        var self = this;

        var queries = [{ all: true }];

        if (testingQueries)
            queries = queries.concat(testingQueries);

        var MutationObserverCtor;

        try {
	        if (typeof WebKitMutationObserver !== 'undefined')
	            MutationObserverCtor = WebKitMutationObserver;
	        else
	            MutationObserverCtor = MutationObserver;
        } catch (e) {
        	MutationObserverCtor = undefined;
        };

        if (MutationObserverCtor !== undefined) {
	        this.mutationSummary = new MutationSummary({
	            rootNode: target,
	            callback: function (summaries) {
	                _this.applyChanged(summaries);
	            },
	            queries: queries
	        });
        }
    }

    TreeMirrorClient.prototype.getDefaultMirror = function() {
      return {
        initialize: function(rootId, children){
          return;
        },
        applyChanged: function(removed, addedOrMoved, attributes, text){
          return;
        }
      }
    }

    TreeMirrorClient.prototype.disconnect = function () {
        if (this.mutationSummary) {
            this.mutationSummary.disconnect();
            this.mutationSummary = undefined;
        }
    };

    TreeMirrorClient.prototype.rememberNode = function (node) {
        var id = this.nextId++;
        this.knownNodes.set(node, id);
        return id;
    };

    TreeMirrorClient.prototype.forgetNode = function (node) {
        this.knownNodes.delete(node);
    };

    TreeMirrorClient.prototype.serializeNode = function (node, recursive) {
        if (node === null)
            return null;

        var id = this.knownNodes.get(node);
        if (id !== undefined) {
            return { id: id };
        }

        var data = {
            nodeType: node.nodeType,
            id: this.rememberNode(node)
        };

        switch (data.nodeType) {
            case Node.DOCUMENT_TYPE_NODE:
                var docType = node;
                data.name = docType.name;
                data.publicId = docType.publicId;
                data.systemId = docType.systemId;
                break;

            case Node.COMMENT_NODE:
            case Node.TEXT_NODE:
                data.textContent = node.textContent;
                break;

            case Node.ELEMENT_NODE:
                var elm = node;
                data.tagName = elm.tagName;
                data.attributes = {};
                for (var i = 0; i < elm.attributes.length; i++) {
                    var attr = elm.attributes[i];
                    data.attributes[attr.name] = attr.value;
                }

                if (recursive && elm.childNodes.length) {
                    data.childNodes = [];

                    for (var child = elm.firstChild; child; child = child.nextSibling)
                        data.childNodes.push(this.serializeNode(child, true));
                }
                break;
        }

        return data;
    };

    TreeMirrorClient.prototype.serializeAddedAndMoved = function (added, reparented, reordered) {
        var _this = this;
        var all = added.concat(reparented).concat(reordered);

        var parentMap = new MutationSummary.NodeMap();

        all.forEach(function (node) {
            var parent = node.parentNode;
            var children = parentMap.get(parent);
            if (!children) {
                children = new MutationSummary.NodeMap();
                parentMap.set(parent, children);
            }

            children.set(node, true);
        });

        var moved = [];

        parentMap.keys().forEach(function (parent) {
            var children = parentMap.get(parent);

            var keys = children.keys();
            while (keys.length) {
                var node = keys[0];
                while (node.previousSibling && children.has(node.previousSibling))
                    node = node.previousSibling;

                while (node && children.has(node)) {
                    var data = _this.serializeNode(node);
                    data.previousSibling = _this.serializeNode(node.previousSibling);
                    data.parentNode = _this.serializeNode(node.parentNode);
                    moved.push(data);
                    children.delete(node);
                    node = node.nextSibling;
                }

                var keys = children.keys();
            }
        });

        return moved;
    };

    TreeMirrorClient.prototype.serializeAttributeChanges = function (attributeChanged) {
        var _this = this;
        var map = new MutationSummary.NodeMap();

        Object.keys(attributeChanged).forEach(function (attrName) {
            attributeChanged[attrName].forEach(function (element) {
                var record = map.get(element);
                if (!record) {
                    record = _this.serializeNode(element);
                    record.attributes = {};
                    map.set(element, record);
                }

                record.attributes[attrName] = element.getAttribute(attrName);
            });
        });

        return map.keys().map(function (node) {
            return map.get(node);
        });
    };

    TreeMirrorClient.prototype.applyChanged = function (summaries) {
        var _this = this;
        var summary = summaries[0];

        var removed = summary.removed.map(function (node) {
          return _this.serializeNode(node);
        });

        var moved = this.serializeAddedAndMoved(summary.added, summary.reparented, summary.reordered);

        var attributes = this.serializeAttributeChanges(summary.attributeChanged);

        var text = summary.characterDataChanged.map(function (node) {
          var data = _this.serializeNode(node);
          data.textContent = node.textContent;
          return data;
        });

        this.mirror.applyChanged(removed, moved, attributes, text);

        summary.removed.forEach(function (node) {
          _this.forgetNode(node);
        });
    };
    return TreeMirrorClient;
})();

module.exports = {
  TreeMirror: TreeMirror,
  TreeMirrorClient: TreeMirrorClient
}

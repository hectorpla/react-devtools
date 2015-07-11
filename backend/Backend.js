/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @ xx flow
 */
'use strict';

import {EventEmitter} from 'events'
import assign from 'object-assign'
import type * as Bridge from './Bridge'

type Component = {};
type DataType = {
  name: ?string,
  type: string | ?Object,
  state: ?Object,
  props: ?Object,
  context: ?Object,
  updater: ?{
    setState: (state: Object) => void,
    forceUpdate: () => void,
    publicInstance: Object,
  },
};

type Bridge = {
  send: (evt: string, data?: any) => void,
  on: (evt: string, fn: (data: any) => any) => void,
  forget: (id: string) => void,
};

type Handle = {};

type InternalsObject = {
  getNativeFromReactElement: (el: Component) => Handle,
  getReactElementFromNative: (node: any) => Handle,
  removeDevtools: () => void,
};

/**
 * Events from React:
 * - root (got a root)
 * - mount (a component mounted)
 * - update (a component updated)
 * - unmount (a component mounted)
 */
class Backend extends EventEmitter {
  comps: Map;
  global: Object;
  ids: WeakMap;
  nodes: Map;
  roots: Set;
  rootIDs: Map;
  reactInternals: InternalsObject; // injected
  capabilities: Object;
  _prevSelected: any;

  constructor(global: Object, capabilities?: Object) {
    super();
    this.global = global;
    this.comps = new Map();
    this.ids = new WeakMap();
    this.nodes = new Map();
    this.roots = new Set();
    this.rootIDs = new Map();
    this.on('selected', id => {
      var data = this.nodes.get(id);
      if (data && data.updater) {
        this.global.$r = data.updater.publicInstance;
      }
    });
    this._prevSelected = null;
    this.capabilities = assign({
      scroll: window.document && 'function' === typeof window.document.createElement && 'function' === typeof window.document.body.scrollIntoView,
      dom: window.document && 'function' === typeof window.document.createElement,
    }, capabilities);
  }

  // todo fix subscription to be more normal?
  // $FlowFixMe you can't override methods and give them a different signature?
  on(ev: string, fn: (data: any) => void): () => void {
    EventEmitter.prototype.on.call(this, ev, fn);
    return () => this.off(ev, fn);
  }

  off(ev: string, fn: (data: any) => void) {
    this.removeListener(ev, fn);
  }

  setReactInternals(reactInternals: InternalsObject) {
    this.reactInternals = reactInternals;
  }

  addBridge(bridge: Bridge) {
    bridge.on('setState', this._setState.bind(this));
    bridge.on('setProps', this._setProps.bind(this));
    bridge.on('setContext', this._setContext.bind(this));
    bridge.on('makeGlobal', this._makeGlobal.bind(this));
    bridge.on('highlight', id => this.highlight(id));
    bridge.on('highlightMany', id => this.highlightMany(id));
    bridge.on('hideHighlight', () => this.emit('hideHighlight'));
    bridge.on('selected', id => this.emit('selected', id));
    bridge.on('shutdown', () => {
      this.emit('shutdown');
      if (this.reactInternals && this.reactInternals.removeDevtools) {
        this.reactInternals.removeDevtools();
      }
    });
    bridge.on('putSelectedNode', id => {
      window.__REACT_DEVTOOLS_BACKEND__.$node = this.getNodeForID(id);
    });
    bridge.on('putSelectedInstance', id => {
      var node = this.nodes.get(id);
      if (node.updater && node.updater.publicInstance) {
        window.__REACT_DEVTOOLS_BACKEND__.$inst = node.updater.publicInstance;
      } else {
        window.__REACT_DEVTOOLS_BACKEND__.$inst = null;
      }
    });
    bridge.on('checkSelection', () => {
      var newSelected = window.__REACT_DEVTOOLS_BACKEND__.$0;
      if (newSelected !== this._prevSelected) {
        this._prevSelected = newSelected;
        var sentSelected = window.__REACT_DEVTOOLS_BACKEND__.$node;
        if (newSelected !== sentSelected) {
          this.selectFromDOMNode(newSelected);
        }
      }
    });
    bridge.on('requestCapabilities', () => {
      bridge.send('capabilities', this.capabilities);
      this.emit('connected');
    });
    bridge.on('scrollToNode', id => this.scrollToNode(id));
    this.on('root', id => bridge.send('root', id))
    this.on('mount', data => bridge.send('mount', data))
    this.on('update', data => bridge.send('update', data));
    this.on('unmount', id => {
      bridge.send('unmount', id)
      bridge.forget(id);
    });
    this.on('setSelection', data => bridge.send('select', data));
  }

  scrollToNode(id: string): void {
    var node = this.getNodeForID(id);
    if (!node) {
      console.warn('unable to get the node for scrolling');
      return;
    }
    if (node.scrollIntoViewIfNeeded) {
      node.scrollIntoViewIfNeeded();
    } else {
      node.scrollIntoView();
    }
    this.highlight(id);
  }

  highlight(id: string) {
    var data = this.nodes.get(id);
    var node = this.getNodeForID(id);
    if (node) {
      this.emit('highlight', {node, name: data.name, props: data.props});
    }
  }

  highlightMany(ids: Array<string>) {
    var nodes = [];
    ids.forEach(id => {
      var node = this.getNodeForID(id);
      if (node) {
        nodes.push(node);
      }
    });
    if (nodes.length) {
      this.emit('highlightMany', nodes);
    }
  }

  getNodeForID(id: string): ?Object {
    var component = this.comps.get(id);
    if (!component) {
      return null;
    }
    if (!this.reactInternals) {
      return null;
    }
    return this.reactInternals.getNativeFromReactElement(component);
  }

  selectFromDOMNode(node: Object, quiet?: boolean) {
    var id = this.getIDForNode(node);
    if (!id) {
      return;
    }
    this.emit('setSelection', {id, quiet});
  }

  selectFromReactInstance(instance: Object, quiet?: boolean) {
    var id = this.getId(instance);
    if (!id) {
      console.log('no instance id', instance);
    }
    this.emit('setSelection', {id, quiet});
  }

  getIDForNode(node: Object): ?string {
    if (!this.reactInternals) {
      return null;
    }
    var component = this.reactInternals.getReactElementFromNative(node);
    if (component) {
      return this.getId(component);
    }
  }

  setEnabled(val: boolean): Object {
    throw new Error("React hasn't injected... what's up?");
  }

  _setProps({id, path, value}: {id: string, path: Array<string>, value: any}) {
    var data = this.nodes.get(id);
    setIn(data.props, path, value);
    if (data.updater && data.updater.forceUpdate) {
      data.updater.forceUpdate();
      this.onUpdated(this.comps.get(id), data);
    } else {
      console.warn("trying to set props on a component that doesn't support it");
    }
  }

  _setState({id, path, value}: {id: string, path: Array<string>, value: any}) {
    var data = this.nodes.get(id);
    setIn(data.state, path, value);
    if (data.updater && data.updater.forceUpdate) {
      data.updater.forceUpdate();
      this.onUpdated(this.comps.get(id), data);
    } else {
      console.warn("trying to set state on a component that doesn't support it");
    }
  }

  _setContext({id, path, value}: {id: string, path: Array<string>, value: any}) {
    var data = this.nodes.get(id);
    setIn(data.context, path, value);
    if (data.updater && data.updater.forceUpdate) {
      data.updater.forceUpdate();
      this.onUpdated(this.comps.get(id), data);
    } else {
      console.warn("trying to set state on a component that doesn't support it");
    }
  }

  _makeGlobal({id, path}: {id: string, path: Array<string>}) {
    var data = this.nodes.get(id);
    var value;
    if (path === 'instance') {
      value = data.updater && data.updater.publicInstance;
    } else {
      value = getIn(data, path);
    }
    this.global.$tmp = value;
    console.log('$tmp =', value);
  }

  getId(element: Component): string {
    if ('object' !== typeof element) {
      return element;
    }
    if (!this.ids.has(element)) {
      this.ids.set(element, randid());
      this.comps.set(this.ids.get(element), element);
    }
    return this.ids.get(element);
  }

  addRoot(element: Component) {
    var id = this.getId(element);
    this.roots.add(id);
    this.emit('root', id);
  }

  onMounted(component: Component, data: DataType) {
    var id = this.getId(component);
    this.nodes.set(id, data);

    var send = assign({}, data);
    if (send.children && send.children.map) {
      send.children = send.children.map(c => this.getId(c));
    }
    send.id = id;
    send.canUpdate = send.updater && !!send.updater.forceUpdate;
    delete send.type;
    delete send.updater;
    this.emit('mount', send);
  }

  onUpdated(component: Component, data: DataType) {
    var id = this.getId(component);
    this.nodes.set(id, data);

    var send = assign({}, data);
    if (send.children && send.children.map) {
      send.children = send.children.map(c => this.getId(c));
    }
    send.id = id;
    send.canUpdate = send.updater && !!send.updater.forceUpdate;
    delete send.type;
    delete send.updater;
    this.emit('update', send)
  }

  onUnmounted(component: Component) {
    var id = this.getId(component);
    this.nodes.delete(id);
    this.roots.delete(id);
    this.emit('unmount', id);
    this.ids.delete(component);
  }
}

function randid() {
  return Math.random().toString(0x0f).slice(10, 20)
}

function setIn(obj, path, value) {
  path = path.slice();
  var name = path.pop();
  var child = path.reduce((obj, attr) => obj ? obj[attr] : null, obj);
  if (child === null) {
    return false;
  }
  child[name] = value;
  return true;
}

function getIn(obj, path) {
  return path.reduce((obj, attr) => {
    return obj ? obj[attr] : null;
  }, obj);
}

module.exports = Backend
import sdAttrs from "../../../libs/snabbdom/src/modules/attributes";
import sdListeners from "../../../libs/snabbdom/src/modules/eventlisteners";
import { init } from "../../../libs/snabbdom/src/snabbdom";
import { VNode } from "../../../libs/snabbdom/src/vnode";
import { QWeb } from "./qweb_vdom";
import { EventBus } from "./event_bus";

//------------------------------------------------------------------------------
// Types/helpers
//------------------------------------------------------------------------------

export interface WEnv {
  qweb: QWeb;
  getID(): number;
}

let wl: any[] = [];
(<any>window).wl = wl;

interface Meta<T extends WEnv> {
  readonly id: number;
  vnode: VNode | null;
  isStarted: boolean;
  isMounted: boolean;
  isDestroyed: boolean;
  parent: BaseWidget<T, any, any> | null;
  children: { [key: number]: BaseWidget<T, any, any> };
  // children mapping: from templateID to widgetID
  // should it be a map number => Widget?
  cmap: { [key: number]: number };
}

const patch = init([sdListeners, sdAttrs]);

export interface Type<T> extends Function {
  new (...args: any[]): T;
}

//------------------------------------------------------------------------------
// Widget
//------------------------------------------------------------------------------

export class BaseWidget<
  T extends WEnv,
  Props,
  State extends {}
> extends EventBus {
  __widget__: Meta<WEnv>;
  template: string = "default";
  inlineTemplate: string | null = null;

  get el(): HTMLElement | null {
    return this.__widget__.vnode ? (<any>this).__widget__.vnode.elm : null;
  }

  env: T;
  state: State = <State>{};
  props: Props;
  refs: {
    [key: string]: BaseWidget<T, any, any> | HTMLElement | undefined;
  } = {};

  //--------------------------------------------------------------------------
  // Lifecycle
  //--------------------------------------------------------------------------

  constructor(parent: BaseWidget<T, any, any> | T, props?: Props) {
    super();
    wl.push(this);

    // is this a good idea?
    //   Pro: if props is empty, we can create easily a widget
    //   Con: this is not really safe
    //   Pro: but creating widget (by a template) is always unsafe anyway
    this.props = <Props>props;
    let id: number;
    let p: BaseWidget<T, any, any> | null = null;
    if (parent instanceof BaseWidget) {
      p = parent;
      this.env = parent.env;
      id = this.env.getID();
      parent.__widget__.children[id] = this;
    } else {
      this.env = parent;
      id = this.env.getID();
    }
    this.__widget__ = {
      id: id,
      vnode: null,
      isStarted: false,
      isMounted: false,
      isDestroyed: false,
      parent: p,
      children: {},
      cmap: {}
    };
  }

  async willStart() {}

  mounted() {}

  shouldUpdate(nextProps: Props): boolean {
    return true;
  }

  willUnmount() {}

  destroyed() {}
  //--------------------------------------------------------------------------
  // Public
  //--------------------------------------------------------------------------

  async mount(target: HTMLElement): Promise<void> {
    await this._start();
    await this.render();
    if (!this.el) {
      // widget was destroyed before we get here...
      return;
    }
    target.appendChild(this.el!);

    if (document.body.contains(target)) {
      this.visitSubTree(w => {
        if (!w.__widget__.isMounted && this.el!.contains(w.el)) {
          w.__widget__.isMounted = true;
          w.mounted();
          return true;
        }
        return false;
      });
    }
  }

  detach() {
    if (this.el) {
      this.visitSubTree(w => {
        if (w.__widget__.isMounted) {
          w.willUnmount();
          w.__widget__.isMounted = false;
          return true;
        }
        return false;
      });
      this.el.remove();
    }
  }

  destroy() {
    if (!this.__widget__.isDestroyed) {
      for (let id in this.__widget__.children) {
        this.__widget__.children[id].destroy();
      }
      if (this.__widget__.isMounted) {
        this.willUnmount();
      }
      if (this.el) {
        this.el.remove();
        this.__widget__.isMounted = false;
        delete this.__widget__.vnode;
      }
      if (this.__widget__.parent) {
        let id = this.__widget__.id;
        delete this.__widget__.parent.__widget__.children[id];
        this.__widget__.parent = null;
      }
      this.clear();
      this.__widget__.isDestroyed = true;
      this.destroyed();
    }
  }

  /**
   * This is the safest update method for widget: its job is to update the state
   * and rerender (if widget is mounted).
   *
   * Notes:
   * - it checks if we do not add extra keys to the state.
   * - it is ok to call updateState before the widget is started. In that
   * case, it will simply update the state and will not rerender
   */
  async updateState(nextState: Partial<State>) {
    if (Object.keys(nextState).length === 0) {
      return;
    }
    Object.assign(this.state, nextState);
    if (this.__widget__.isStarted) {
      return this.render();
    }
  }

  updateProps(nextProps: Props): Promise<void> {
    const shouldUpdate = this.shouldUpdate(nextProps);
    this.props = nextProps;
    return shouldUpdate ? this.render() : Promise.resolve();
  }

  //--------------------------------------------------------------------------
  // Private
  //--------------------------------------------------------------------------

  async render(): Promise<void> {
    if (this.__widget__.isDestroyed) {
      return;
    }
    const vnode = await this._render();
    this.__widget__.vnode = patch(
      this.__widget__.vnode || document.createElement(vnode.sel!),
      vnode
    );
  }

  private async _start(): Promise<void> {
    await this.willStart();
    if (!this.__widget__.isDestroyed) {
      this.__widget__.isStarted = true;
    }
    if (this.inlineTemplate) {
      this.env.qweb.addTemplate(this.inlineTemplate, this.inlineTemplate, true);
    }
  }

  private async _render(): Promise<VNode> {
    const promises: Promise<void>[] = [];
    const template = this.inlineTemplate || this.template;
    let vnode = this.env.qweb.render(template, this, { promises });

    // this part is critical for the patching process to be done correctly. The
    // tricky part is that a child widget can be rerendered on its own, which
    // will update its own vnode representation without the knowledge of the
    // parent widget.  With this, we make sure that the parent widget will be
    // able to patch itself properly after
    vnode.key = this.__widget__.id;
    return Promise.all(promises).then(() => vnode);
  }

  /**
   * Only called by qweb t-widget directive
   */
  _mount(vnode: VNode, elm: HTMLElement): VNode {
    this.__widget__.vnode = patch(elm, vnode);
    this.__mount();
    return this.__widget__.vnode;
  }

  __mount() {
    if (this.__widget__.isMounted) {
      return;
    }
    if (this.__widget__.parent) {
      if (this.__widget__.parent!.__widget__.isMounted) {
        this.__widget__.isMounted = true;
        this.mounted();
        const children = this.__widget__.children;
        for (let id in children) {
          children[id].__mount();
        }
      }
    }
  }

  private visitSubTree(callback: (w: BaseWidget<T, any, any>) => boolean) {
    const shouldVisitChildren = callback(this);
    if (shouldVisitChildren) {
      const children = this.__widget__.children;
      for (let id in children) {
        children[id].visitSubTree(callback);
      }
    }
  }
}

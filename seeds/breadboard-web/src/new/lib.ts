/**
 * @license
 * Copyright 2023 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  GraphDescriptor,
  GraphMetadata,
  NodeDescriptor,
  Edge,
  SubGraphs,
  Kit,
  KitConstructor,
  InputValues as OriginalInputValues,
  OutputValues as OriginalOutputValues,
  NodeFactory as OriginalNodeFactory,
  BoardRunner as OriginalBoardRunner,
  BreadboardRunner,
  BreadboardRunResult,
  NodeHandlerContext,
  BreadboardValidator,
} from "@google-labs/breadboard";

// TODO:BASE: Same as before, but I added NodeFactory as base type, which is a
// way to encapsulate boards, including lambdas (instead of BoardCapability).
// Can keep it a capability, but this feels quite fundamental.
export type NodeValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | NodeValue[]
  | PromiseLike<NodeValue>
  | { [key: string]: NodeValue }
  | NodeFactory<InputValues, OutputValues>;

type NodeTypeIdentifier = string;

export type InputValues = { [key: string]: NodeValue };

export type OutputValues = { [key: string]: NodeValue };
type OutputValue<T> = Partial<{ [key: string]: T }>;

// TODO:BASE: This is pure syntactic sugar and should _not_ be moved
type InputsMaybeAsValues<
  T extends InputValues,
  NI extends InputValues = InputValues
> = Partial<{
  [K in keyof T]: Value<T[K]> | NodeProxy<NI, OutputValue<T[K]>> | T[K];
}> & {
  [key in string]:
    | Value<NodeValue>
    | NodeProxy<NI, Partial<InputValues>>
    | NodeValue;
};

// TODO:BASE: Allowing inputs to be promises. In syntactic sugar this should
// actually be a NodeProxy on an input node (which looks like a promise).
export type NodeHandlerFunction<
  I extends InputValues,
  O extends OutputValues
> = (
  inputs: PromiseLike<I> & InputsMaybeAsValues<I>,
  node: NodeImpl<I, O>
) => O | PromiseLike<O>;

// TODO:BASE: New: Allow handlers to accepts inputs as a promise.
// See also hack in handlersFromKit() below.
type NodeHandler<
  I extends InputValues = InputValues,
  O extends OutputValues = OutputValues
> =
  | {
      invoke: NodeHandlerFunction<I, O>;
      // describe?: NodeDescriberFunction<I, O>;
    }
  | NodeHandlerFunction<I, O>; // Is assumed to accept promises

type NodeHandlers = Record<
  NodeTypeIdentifier,
  NodeHandler<InputValues, OutputValues>
>;

export type NodeFactory<I extends InputValues, O extends OutputValues> = (
  config?: NodeImpl<InputValues, I> | Value<NodeValue> | InputsMaybeAsValues<I>
) => NodeProxy<I, O>;

// TODO:BASE: This does two things
//   (1) register a handler with the runner
//   (2) create a factory function for the node type
// BASE should only be the first part, the second part should be in the syntax
export function addNodeType<I extends InputValues, O extends OutputValues>(
  name: string,
  handler: NodeHandler<I, O>
): NodeFactory<I, O> {
  getCurrentContextRunner().addHandlers({
    [name]: handler as unknown as NodeHandler,
  });
  return ((config?: InputsMaybeAsValues<I>) => {
    return new NodeImpl(name, getCurrentContextRunner(), config).asProxy();
  }) as unknown as NodeFactory<I, O>;
}

export interface Serializeable {
  serialize(
    metadata?: GraphMetadata
  ): Promise<GraphDescriptor> | GraphDescriptor;
}

export function action<
  I extends InputValues = InputValues,
  O extends OutputValues = OutputValues
>(fn: NodeHandlerFunction<I, O>): NodeFactory<I, O> & Serializeable {
  const factory = addNodeType(getNextNodeId("fn"), fn) as NodeFactory<I, O> &
    Serializeable;
  factory.serialize = async (metadata?) => {
    const node = new NodeImpl(fn, getCurrentContextRunner());
    const [singleNode, graph] = await node.serializeNode();
    // If there is a subgraph that is invoked, just return that.
    if (graph) return { ...metadata, ...graph } as GraphDescriptor;
    // Otherwise return the node, most likely a runJavascript node.
    else return { ...metadata, edges: [], nodes: [singleNode] };
  };
  return factory;
}

// TODO:BASE: This is wraps classic handlers that expected resolved inputs
// into something that accepts promises. We should either change all handlers
// to support promises or add a flag or something to support either mode.
// (Almost all handlers will immediately await, so it's a bit of a pain...)
function handlersFromKit(kit: Kit): NodeHandlers {
  return Object.fromEntries(
    Object.entries(kit.handlers).map(([name, handler]) => {
      const handlerFunction =
        handler instanceof Function ? handler : handler.invoke;
      return [
        name,
        {
          invoke: async (inputs) => {
            return handlerFunction(
              (await inputs) as OriginalInputValues,
              {}
            ) as Promise<OutputValues>;
          },
        },
      ];
    })
  );
}

// Extracts handlers from kits and creates node factorie for them.
export function addKit<T extends Kit>(
  ctr: KitConstructor<T>
): { [key: string]: NodeFactory<InputValues, OutputValues> } {
  const kit = new ctr({} as unknown as OriginalNodeFactory);
  const handlers = handlersFromKit(kit);
  return Object.fromEntries(
    Object.entries(handlers).map(([name, handler]) => [
      name,
      addNodeType(name, handler),
    ])
  );
}

// TODO:BASE This is almost `Edge`, except that it's references to nodes and not
// node ids. Also optional is missing.
export interface EdgeImpl<
  FromI extends InputValues = InputValues,
  FromO extends OutputValues = OutputValues,
  ToI extends InputValues = InputValues,
  ToO extends OutputValues = OutputValues
> {
  from: NodeImpl<FromI, FromO>;
  to: NodeImpl<ToI, ToO>;
  out: string;
  in: string;
  constant?: boolean;
}

// TODO:BASE: Decide whether this is part of the base or each syntactic layer
// needs to figure out how to assign ids.
let nodeIdCounter = 0;
const getNextNodeId = (type: string) => {
  return `${type}-${nodeIdCounter++}`;
};

type NodeProxyInterface<I extends InputValues, O extends OutputValues> = {
  then<TResult1 = O, TResult2 = never>(
    onfulfilled?: ((value: O) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2>;
  to<
    ToO extends OutputValues = OutputValues,
    ToC extends InputValues = InputValues
  >(
    to:
      | NodeProxy<O & ToC, ToO>
      | NodeTypeIdentifier
      | NodeHandler<O & ToC, ToO>,
    config?: ToC
  ): NodeProxy<O & ToC, ToO>;
  in(
    inputs:
      | NodeProxy<InputValues, Partial<I>>
      | InputsMaybeAsValues<I>
      | Value<NodeValue>
  ): NodeProxy<I, O>;
  as(keymap: KeyMap): Value;
};

/**
 * Intersection between a Node and a Promise for its output:
 *  - Has all the output fields as Value<T> instances.
 *  - Has all the methods of the NodeProxyInterface defined above.
 *  - Including then() which makes it a PromiseLike<O>
 */
export type NodeProxy<
  I extends InputValues = InputValues,
  O extends OutputValues = OutputValues
> = {
  [K in keyof O]: Value<O[K]> & ((...args: unknown[]) => unknown);
} & {
  [key in string]: Value<NodeValue> & ((...args: unknown[]) => unknown);
} & NodeProxyInterface<I, O>;

type KeyMap = { [key: string]: string };

class AwaitWhileSerializing extends Error {}

// TODO:BASE Extract base class that isn't opinioanted about the syntax. Marking
// methods that should be base as "TODO:BASE" below, including complications.
class NodeImpl<
  I extends InputValues = InputValues,
  O extends OutputValues = OutputValues
> implements NodeProxyInterface<I, O>, PromiseLike<O>, Serializeable
{
  id: string;
  type: string;
  outgoing: EdgeImpl[] = [];
  incoming: EdgeImpl[] = [];
  configuration: Partial<I> = {};

  #handler?: NodeHandler<InputValues, OutputValues>;

  #promise: Promise<O>;
  #resolve?: (value: O | PromiseLike<O>) => void;
  #reject?: (reason?: unknown) => void;

  #inputs: Partial<I>;
  #constants: Partial<I> = {};
  #receivedFrom: NodeImpl[] = [];
  #outputs?: O;

  #runner: Runner;

  // TODO:BASE: The syntax specific one will
  // - handle passing functions
  // - extract the wires from the config
  // - then call the original constructor
  // - then add the wires
  // - then add the spread value hack
  // - then add the promises
  //
  // Open question: Is assigning of default ids something the base class does or
  // should it error out if there isn't an id and require each syntax to define
  // their own default id generation scheme?
  constructor(
    handler: NodeTypeIdentifier | NodeHandler<I, O>,
    runner: Runner,
    config: (Partial<InputsMaybeAsValues<I>> | Value<NodeValue>) & {
      $id?: string;
    } = {}
  ) {
    this.#runner = runner;

    if (typeof handler === "string") {
      this.type = handler;
    } else {
      this.type = "fn";
      this.#handler = handler as unknown as NodeHandler<
        InputValues,
        OutputValues
      >;
    }

    let id: string | undefined = undefined;

    if (config instanceof NodeImpl) {
      this.addInputsFromNode(config.unProxy());
    } else if (isValue(config)) {
      this.addInputsFromNode(...(config as Value).asNodeInput());
    } else {
      const { $id, ...rest } = config as Partial<InputsMaybeAsValues<I>> & {
        $id?: string;
      };
      id = $id;
      this.addInputsAsValues(rest as InputsMaybeAsValues<I>);

      // Treat incoming constants as configuration
      this.configuration = { ...this.configuration, ...this.#constants };
      this.#constants = {};
    }

    this.#inputs = { ...this.configuration };

    this.id = id || getNextNodeId(this.type);

    // Set up spread value, so that { ...node } as input works.
    (this as unknown as { [key: string]: NodeImpl<I, O> })[this.#spreadKey()] =
      this;

    this.#promise = new Promise<O>((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
  }

  addInputsAsValues(values: InputsMaybeAsValues<I>) {
    // Split into constants and nodes
    const constants: Partial<InputValues> = {};
    const nodes: [NodeImpl<InputValues, OutputValues>, KeyMap, boolean][] = [];

    Object.entries(values).forEach(([key, value]) => {
      if (isValue(value)) {
        nodes.push((value as Value).as(key).asNodeInput());
      } else if (value instanceof NodeImpl) {
        nodes.push([value.unProxy(), { [key]: key }, false]);
      } else {
        constants[key] = value;
      }
    });

    this.#constants = { ...this.#constants, ...constants };
    nodes.forEach((node) => this.addInputsFromNode(...node));
  }

  // Add inputs from another node as edges
  addInputsFromNode(
    from: NodeImpl,
    keymap: KeyMap = { "*": "*" },
    constant?: boolean
  ) {
    const keyPairs = Object.entries(keymap);
    if (keyPairs.length === 0) {
      // Add an empty edge: Just control flow, no data moving.

      const edge: EdgeImpl = {
        to: this as unknown as NodeImpl,
        from,
        out: "",
        in: "",
      };
      this.incoming.push(edge);
      from.outgoing.push(edge);
    } else
      keyPairs.forEach(([fromKey, toKey]) => {
        // "*-<id>" means "all outputs from <id>" and comes from using a node in
        // a spread, e.g. newNode({ ...node, $id: "id" }
        if (fromKey.startsWith("*-")) fromKey = toKey = "*";

        const edge: EdgeImpl = {
          to: this as unknown as NodeImpl,
          from,
          out: fromKey,
          in: toKey,
        };

        if (constant) edge.constant = true;

        this.incoming.push(edge);
        from.outgoing.push(edge);
      });
  }

  // TODO:BASE (this shouldn't require any changes)
  receiveInputs(edge: EdgeImpl, inputs: InputValues) {
    const data =
      edge.out === "*"
        ? inputs
        : edge.out === ""
        ? {}
        : { [edge.in]: inputs[edge.out] };

    if (edge.constant) this.#constants = { ...this.#constants, ...data };

    this.#inputs = { ...this.#inputs, ...data };
    this.#receivedFrom.push(edge.from);
  }

  // TODO:BASE (this shouldn't require any changes)
  /**
   * Compute required inputs from edges and compare with present inputs
   *
   * Required inputs are
   *  - for all named incoming edges, the presence of any data, irrespective of
   *    which node they come from
   *  - for all empty or * incoming edges, that the from node has sent data
   *  - data from at least one node if it already ran (#this.outputs not empty)
   *
   * @returns true if all required inputs are present
   */
  hasAllRequiredInputs() {
    const requiredKeys = new Set(
      this.incoming
        .map((edge) => edge.in)
        .filter((key) => !["", "*"].includes(key))
    );
    const requiredNodes = new Set(
      this.incoming
        .filter((edge) => ["", "*"].includes(edge.out))
        .map((edge) => edge.from)
    );

    const presentKeys = new Set([
      ...Object.keys(this.#inputs),
      ...Object.keys(this.#constants),
    ]);
    const presentNodes = new Set(this.#receivedFrom);

    return (
      [...requiredKeys].every((key) => presentKeys.has(key)) &&
      [...requiredNodes].every((node) => presentNodes.has(node)) &&
      (!this.#outputs || presentNodes.size > 0)
    );
  }

  // TODO:BASE
  getInputs() {
    return { ...this.#inputs };
  }

  #getHandlerFunction(runner: Runner) {
    const handler = this.#handler ?? runner.getHandler(this.type);
    if (!handler) throw new Error(`Handler ${this.type} not found`);
    return typeof handler === "function" ? handler : handler.invoke;
  }

  // TODO:BASE: In the end, we need to capture the outputs and resolve the
  // promise. But before that there is a bit of refactoring to do to allow
  // returning of graphs, parallel execution, etc.
  async invoke(callingRunner?: Runner): Promise<O> {
    const runner = new Runner(
      callingRunner ? [callingRunner, this.#runner] : [this.#runner]
    );
    return runner.asRunnerFor(async () => {
      try {
        const handler = this.#getHandlerFunction(
          runner
        ) as unknown as NodeHandlerFunction<I, O>;

        // Note: The handler might actually return a graph (as a NodeProxy), and
        // so the await might triggers its execution. This is what we want.
        //
        // Awaiting here means that parallel execution isn't possible.
        // TODO: Return a promise that knows how to do the rest. Make sure to
        // never invoke the handler twice while it is running, though.
        //
        // TODO: What this should do instead is much closer to what the
        // serialization code below does. It should:
        //  - add an input node, assign the inputs to it
        //  - call the handler with that input node's proxy (this gives it all
        //    the values, but as promises) if it supports promises, otherwise
        //    call it with the values directly.
        //  - if the handler returns a node (i.e. a graph), and
        //    - it isn't an output node, add an output node and wire it up
        //    - execute the graph, and return the output node's outputs
        //  - otherwise return the handler's return value as result.
        const result = await handler(
          this.#inputs as unknown as PromiseLike<I> & InputsMaybeAsValues<I>,
          this
        );

        // Resolve promise, but only on first run (outputs is still empty)
        if (this.#resolve && !this.#outputs) this.#resolve(result);

        this.#outputs = result;

        // Clear inputs, reset with configuration and constants
        this.#inputs = { ...this.configuration, ...this.#constants };
        this.#receivedFrom = [];

        return result;
      } catch (e) {
        // Reject promise, but only on first run (outputs is still empty)
        if (this.#reject && !this.#outputs) this.#reject(e);
        throw e;
      }
    })();
  }

  // TODO:BASE
  async serialize(metadata?: GraphMetadata) {
    return this.#runner.serialize(this as unknown as NodeImpl, metadata);
  }

  // TODO:BASE Special casing the function case (which is most of the code
  // here), everything else is the same, but really just the first few lines
  // here.
  async serializeNode(): Promise<[NodeDescriptor, GraphDescriptor?]> {
    const node = {
      id: this.id,
      type: this.type,
      configuration: this.configuration as OriginalInputValues,
    };

    if (this.type !== "fn") return [node];

    const runner = new Runner([this.#runner], { serialize: true });

    const graph = await runner.asRunnerFor(async () => {
      try {
        const handler = this.#getHandlerFunction(
          runner
        ) as unknown as NodeHandlerFunction<I, O>;

        const inputNode = new NodeImpl<InputValues, I>("input", runner, {});
        const outputNode = new NodeImpl<O, O>("output", runner, {});

        const result = handler(inputNode.asProxy(), this);

        if (result instanceof NodeImpl) {
          // If the handler returned an output node, serialize it directly,
          // otherwise connect the returned node's outputs to the output node.
          if (result.unProxy().type === "output")
            return runner.serialize(result as unknown as NodeImpl);
          outputNode.addInputsFromNode(result.unProxy());
        } else if (isValue(result)) {
          // Wire up the value to the output node
          const value = isValue(result) as Value;
          outputNode.addInputsFromNode(...value.asNodeInput());
        } else {
          // Otherwise wire up all keys of the returned object to the output.
          let output = await result;

          // If the result is not an object, assume "result" as key.
          if (typeof output !== "object")
            output = (
              output !== undefined ? { result: output as NodeValue } : {}
            ) as O;

          // Refactor to merge with similar code in constructor
          Object.keys(output).forEach((key) =>
            isValue(output[key])
              ? outputNode.addInputsFromNode(
                  ...(output[key] as Value).as(key).asNodeInput()
                )
              : output[key] instanceof NodeImpl
              ? outputNode.addInputsFromNode(output[key] as NodeImpl, {
                  [key]: key,
                })
              : (outputNode.configuration[key as keyof O] = output[
                  key
                ] as (typeof outputNode.configuration)[keyof O])
          );
        }
        return runner.serialize(outputNode as unknown as NodeImpl);
      } catch (e) {
        if (e instanceof AwaitWhileSerializing) return null;
        else throw e;
      }
    })();

    // If we got a graph back, save it as a subgraph (returned as second value)
    // and turns this into an invoke node.
    if (graph) {
      node.type = "invoke";
      node.configuration = { ...node.configuration, graph: "#" + this.id };
      return [node, graph];
    }

    // Else, serialize the handler itself and return a runJavascript node.
    let code = this.#handler?.toString() ?? ""; // The ?? is just for typescript
    let name = this.id.replace(/-/g, "_");

    const arrowFunctionRegex = /(?:async\s+)?(\w+|\([^)]*\))\s*=>\s*/;
    const traditionalFunctionRegex =
      /(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)\s*\{/;

    if (arrowFunctionRegex.test(code)) {
      // It's an arrow function, convert to traditional
      code = code.replace(arrowFunctionRegex, (_, params) => {
        const async = code.trim().startsWith("async") ? "async " : "";
        const paramsWithParens = params.startsWith("(")
          ? params
          : `(${params})`;
        return `${async}function ${name}${paramsWithParens} `;
      });
    } else {
      const match = traditionalFunctionRegex.exec(code);
      if (match === null) throw new Error("Unexpected seralization: " + code);
      else name = match[1] || name;
    }

    node.type = "runJavascript";
    node.configuration = { ...node.configuration, code, name };

    return [node];
  }

  /**
   * Creates a proxy for a Node that is used when constructing a graph.
   *
   *   const node = originalNode.asProxy();
   *
   * It acts as a Promise for the Node's output by implementing a `then` method:
   *   const output = await node;
   *
   * It acts a proxy for Promises for the Node's output's members.
   *   const field = await node.field;
   *
   * You can still call methods on the Node:
   *   node.to(nextNode);
   *
   * You can do that on output members too:
   *   node.field.to(nextNode);
   *
   * This even works for its methods and `then` and other reserved words:
   *   const to = await node.to;
   *   const thenValue = await node.then; // note: not then()
   *   node.then.to(nextNode); // send the value of `then` to nextNode
   *   node.to.to(nextNode);   // same for the value of `to`.
   *
   *
   * To achieve this, we use a Proxy that creates instances of Value for each
   * requested key, as if it was an output of the node. If there is a method on
   * node with the same name, we return a proxy for that method instead, that
   * forwards all gets to the Value instance. As this includes the `then` method
   * defined on the value, `await node.foo` works, even though `node.foo` is a a
   * function. That it is a function is important for `node.then`, so that the
   * node acts like a Promise as well.
   *
   */
  // TODO: Hack keys() to make spread work
  asProxy(): NodeProxy<I, O> {
    return new Proxy(this, {
      get(target, prop, receiver) {
        if (typeof prop === "string") {
          const value = new Value(
            target as unknown as NodeImpl<InputValues, OutputValues>,
            target.#runner,
            prop
          );
          const method = target[prop as keyof NodeImpl<I, O>] as () => void;
          if (method && typeof method === "function") {
            return new Proxy(method.bind(target), {
              get(_, key, __) {
                return Reflect.get(value, key, value);
              },
              ownKeys(_) {
                return Reflect.ownKeys(value).filter(
                  (key) => typeof key === "string"
                );
              },
            });
          } else {
            return value;
          }
        } else {
          return Reflect.get(target, prop, receiver);
        }
      },
      ownKeys(target) {
        return [target.#spreadKey()];
      },
    }) as unknown as NodeProxy<I, O>;
  }

  /**
   * Retrieve underlying node from a NodeProxy. Use like this:
   *
   * if (thing instanceof NodeImpl) { const node = thing.unProxy(); }
   *
   * @returns A NodeImpl that is not a proxy, but the original NodeImpl.
   */
  unProxy() {
    return this;
  }

  /****
   * Implementations of NodeProxyInterface, used for constructing Graphs,
   * typically invoked on this.asProxy().
   */

  /**
   * Makes the node (and its proxy) act as a Promise, which returns the output
   * of the node. This trigger the execution of the graph built up so far.
   *
   * this.#promise is a Promise that gets resolved with the (first and only the
   * first) invoke() call of the node. It is resolved with the outputs.
   */
  then<TResult1 = O, TResult2 = never>(
    onfulfilled?: ((value: O) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2> {
    if (this.#runner.serializing()) throw new AwaitWhileSerializing();

    try {
      // It's ok to call this multiple times: If it already run it'll only do
      // something if new nodes or inputs were added (e.g. between await calls)
      this.#runner.invoke(this as unknown as NodeImpl);
    } catch (e) {
      if (onrejected) onrejected(e);
      else throw e;
    }

    return this.#promise.then(
      onfulfilled && this.#runner.asRunnerFor(onfulfilled),
      onrejected && this.#runner.asRunnerFor(onrejected)
    );
  }

  to<
    ToO extends OutputValues = OutputValues,
    ToC extends InputValues = InputValues
  >(
    to:
      | NodeProxy<O & ToC, ToO>
      | NodeTypeIdentifier
      | NodeHandler<O & ToC, ToO>,
    config?: ToC
  ): NodeProxy<O & ToC, ToO> {
    const toNode =
      to instanceof NodeImpl
        ? to.unProxy()
        : new NodeImpl(
            to as NodeTypeIdentifier | NodeHandler<Partial<O> & ToC, ToO>,
            this.#runner,
            config as Partial<O> & ToC
          );

    // TODO: Ideally we would look at the schema here and use * only if
    // the output is open ended and/or not all fields are present all the time.
    toNode.addInputsFromNode(this as unknown as NodeImpl, { "*": "*" });

    return (toNode as NodeImpl<O & ToC, ToO>).asProxy();
  }

  in(
    inputs:
      | NodeProxy<InputValues, Partial<I>>
      | InputsMaybeAsValues<I>
      | Value<NodeValue>
  ) {
    if (inputs instanceof NodeImpl) {
      const node = inputs as NodeImpl<InputValues, OutputValues>;
      this.addInputsFromNode(node);
    } else if (isValue(inputs)) {
      const value = inputs as Value;
      this.addInputsFromNode(...value.asNodeInput());
    } else {
      const values = inputs as InputsMaybeAsValues<I>;
      this.addInputsAsValues(values);
    }
    return this.asProxy();
  }

  as(keymap: KeyMap): Value {
    return new Value<NodeValue>(
      this as unknown as NodeImpl,
      this.#runner,
      keymap
    );
  }

  keys() {
    return [this.#spreadKey()];
  }

  #spreadKey() {
    return "*-" + this.id;
  }
}

// Because Value is sometimes behind a function Proxy (see above, for NodeImpl's
// methods), we need to use this approach to identify Value instead instanceof.
export const IsValueSymbol = Symbol("IsValue");

function isValue<T extends NodeValue = NodeValue>(
  obj: unknown
): Value<T> | false {
  return (
    typeof obj === "object" &&
    (obj as unknown as { [key: symbol]: boolean })[IsValueSymbol] &&
    (obj as unknown as Value<T>)
  );
}

class Value<T extends NodeValue = NodeValue>
  implements PromiseLike<T | undefined>
{
  #node: NodeImpl<InputValues, OutputValue<T>>;
  #runner: Runner;
  #keymap: KeyMap;
  #constant: boolean;

  constructor(
    node: NodeImpl<InputValues, OutputValue<T>>,
    runner: Runner,
    keymap: string | KeyMap,
    constant = false
  ) {
    this.#node = node;
    this.#runner = runner;
    this.#keymap = typeof keymap === "string" ? { [keymap]: keymap } : keymap;
    (this as unknown as { [key: symbol]: Value<T> })[IsValueSymbol] = this;
    this.#constant = constant;
  }

  then<TResult1 = T | undefined, TResult2 = never>(
    onfulfilled?:
      | ((value: T | undefined) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2> {
    if (Object.keys(this.#keymap).length !== 1)
      throw Error("Can't `await` for multiple values");
    return this.#node.then(
      (o) =>
        o &&
        onfulfilled &&
        this.#runner.asRunnerFor(onfulfilled)(o[Object.keys(this.#keymap)[0]]),
      onrejected && this.#runner.asRunnerFor(onrejected)
    ) as PromiseLike<TResult1 | TResult2>;
  }

  asNodeInput(): [
    NodeImpl<InputValues, OutputValues>,
    { [key: string]: string },
    constant: boolean
  ] {
    return [
      this.#node.unProxy() as NodeImpl<InputValues, OutputValues>,
      this.#keymap,
      this.#constant,
    ];
  }

  to<
    ToO extends OutputValues = OutputValues,
    ToC extends InputValues = InputValues
  >(
    to:
      | NodeProxy<OutputValue<T> & ToC, ToO>
      | NodeTypeIdentifier
      | NodeHandler<OutputValue<T> & ToC, ToO>,
    config?: ToC
  ): NodeProxy<OutputValue<T> & ToC, ToO> {
    const toNode =
      to instanceof NodeImpl
        ? to.unProxy()
        : new NodeImpl(
            to as NodeTypeIdentifier | NodeHandler<OutputValue<T> & ToC, ToO>,
            this.#runner,
            config as OutputValue<T> & ToC
          );

    toNode.addInputsFromNode(
      this.#node as unknown as NodeImpl,
      this.#keymap,
      this.#constant
    );

    return (toNode as NodeImpl<OutputValue<T> & ToC, ToO>).asProxy();
  }

  // TODO: Double check this, as it's acting on output types, not input types.
  in(inputs: NodeImpl<InputValues, OutputValues> | InputValues) {
    if (inputs instanceof NodeImpl || isValue(inputs)) {
      let invertedMap = Object.fromEntries(
        Object.entries(this.#keymap).map(([fromKey, toKey]) => [toKey, fromKey])
      );
      const asValue = isValue(inputs);
      if (asValue) {
        invertedMap = asValue.#remapKeys(invertedMap);
        this.#node.addInputsFromNode(asValue.#node, invertedMap);
      } else {
        this.#node.addInputsFromNode(inputs as NodeImpl, invertedMap);
      }
    } else {
      this.#node.addInputsAsValues(inputs);
    }
  }

  as(newKey: string | KeyMap): Value<T> {
    let newMap: KeyMap;
    if (typeof newKey === "string") {
      if (Object.keys(this.#keymap).length !== 1)
        throw new Error("Can't rename multiple values with a single string");
      newMap = { [Object.keys(this.#keymap)[0]]: newKey };
    } else {
      newMap = this.#remapKeys(newKey);
    }

    return new Value(this.#node, this.#runner, newMap, this.#constant);
  }

  memoize() {
    return new Value(this.#node, this.#runner, this.#keymap, true);
  }

  #remapKeys(newKeys: KeyMap) {
    const newMap = { ...this.#keymap };
    Object.entries(newKeys).forEach(([fromKey, toKey]) => {
      if (this.#keymap[toKey]) {
        newMap[fromKey] = this.#keymap[toKey];
        delete this.#keymap[toKey];
      } else {
        newMap[fromKey] = toKey;
      }
    });
    return newMap;
  }
}

interface RunnerConfig {
  serialize?: boolean;
  probe?: EventTarget;
}

// TODO:BASE Maybe this should really be "Scope"?
export class Runner {
  #config: RunnerConfig = { serialize: false };
  #parents?: Runner[];

  #handlers: NodeHandlers = {};

  // TODO:BASE, config of subclasses can have more fields
  constructor(parents: Runner[] = [], config?: RunnerConfig) {
    this.#parents = parents;
    if (config) {
      this.#config = { ...this.#config, ...config };
    }
  }

  // TODO:BASE
  addHandlers(handlers: NodeHandlers) {
    Object.entries(handlers).forEach(
      ([name, handler]) => (this.#handlers[name] = handler)
    );
  }

  // TODO:BASE
  /**
   * Finds handler by name
   *
   * Scans up the parent chain if not found in this runner. It's a depth-first
   * search prioritizing the runners earlier in the list, by convention the
   * calling runners before the declaration context runners.
   *
   * That is, if a graph is invoked with a specific set of kits, then those kits
   * have precedence over kits declared when building the graphs. And kits
   * declared by invoking graphs downstream have precedence over those declared
   * upstream.
   *
   * @param name Name of the handler to retrieve
   * @returns Handler or undefined
   */
  getHandler<
    I extends InputValues = InputValues,
    O extends OutputValues = OutputValues
  >(name: string): NodeHandler<I, O> | undefined {
    return (this.#handlers[name] ||
      this.#parents?.reduce(
        (result, parent) => result ?? parent.getHandler(name),
        undefined as NodeHandler | undefined
      )) as unknown as NodeHandler<I, O>;
  }

  /**
   * Swap global runner with this one, run the function, then restore
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  asRunnerFor<T extends (...args: any[]) => any>(fn: T): T {
    return ((...args: unknown[]) => {
      const oldRunner = swapCurrentContextRunner(this);
      try {
        return fn(...args);
      } finally {
        swapCurrentContextRunner(oldRunner);
      }
    }) as T;
  }

  // TODO:BASE - and really this should implement .run() and .runOnce()
  async invoke(node: NodeImpl) {
    const queue: NodeImpl[] = this.#findAllConnectedNodes(node).filter((node) =>
      node.hasAllRequiredInputs()
    );

    while (queue.length) {
      const node = queue.shift() as NodeImpl;

      // Check if we have all inputs. This should always be the case.
      if (!node.hasAllRequiredInputs())
        throw new Error("Node in queue didn't have all required inputs. Bug.");

      // Invoke node
      const result = await node.invoke(this);

      // Distribute data to outgoing edges
      node.outgoing.forEach((edge) => {
        edge.to.receiveInputs(edge, result);

        // If it's ready to run, add it to the queue
        if (edge.to.hasAllRequiredInputs()) queue.push(edge.to);
      });
    }
  }

  // TODO:BASE
  async *run(anyNode: NodeImpl) {
    const queue: NodeImpl[] = this.#findAllConnectedNodes(anyNode).filter(
      (node) => node.hasAllRequiredInputs()
    );

    while (queue.length) {
      const node = queue.shift() as NodeImpl;

      // Check if we have all inputs. This should always be the case.
      if (!node.hasAllRequiredInputs())
        throw new Error("Node in queue didn't have all required inputs. Bug.");

      // Invoke node
      let result: OutputValues;

      const descriptor = {
        id: node.id,
        type: node.type,
        configuration: node.configuration,
      } as NodeDescriptor;
      const inputs = node.getInputs() as OriginalInputValues;
      const type =
        node.type === "input"
          ? "input"
          : node.type === "output"
          ? "output"
          : "beforehandler";
      const runResult: BreadboardRunResult = {
        type,
        node: descriptor,
        inputArguments: inputs,
        inputs: {},
        outputs: inputs,
        state: { skip: false } as unknown as BreadboardRunResult["state"],
      };

      if (type === "beforehandler") {
        yield runResult;
        const beforeHandlerDetail = {
          descriptor,
          inputs,
          outputs: Promise.resolve({}),
        };
        const shouldInvokeHandler =
          !this.#config.probe ||
          this.#config.probe?.dispatchEvent(
            // Using CustomEvent instead of ProbeEvent because not enough types
            // are currently exported by breadboard, and I didn't want to change
            // too much while prototyping. TODO: Fix this.
            new CustomEvent("beforehandler", {
              detail: beforeHandlerDetail,
              cancelable: true,
            })
          );
        if (shouldInvokeHandler) result = await node.invoke(this);
        else result = (await beforeHandlerDetail.outputs) as OutputValues;
        this.#config.probe?.dispatchEvent(
          new CustomEvent("node", {
            detail: { descriptor, inputs, outputs: result },
            cancelable: true,
          })
        );
      } else if (type === "input") {
        yield runResult;
        result = runResult.inputs as OutputValues;
        this.#config.probe?.dispatchEvent(
          new CustomEvent("input", {
            detail: { descriptor, inputs, outputs: result },
            cancelable: true,
          })
        );
      } /* node.type === "output" */ else {
        this.#config.probe?.dispatchEvent(
          new CustomEvent("output", {
            detail: { descriptor, inputs },
            cancelable: true,
          })
        );
        yield runResult;
        result = {};
      }

      // Distribute data to outgoing edges
      node.outgoing.forEach((edge) => {
        edge.to.receiveInputs(edge, result);

        // If it's ready to run, add it to the queue
        if (edge.to.hasAllRequiredInputs()) queue.push(edge.to);
      });
    }
  }

  // TODO:BASE, should be complete.
  async serialize(
    node: NodeImpl,
    metadata?: GraphMetadata
  ): Promise<GraphDescriptor> {
    const queue: NodeImpl[] = this.#findAllConnectedNodes(node);

    const graphs: SubGraphs = {};

    const nodes = await Promise.all(
      queue.map(async (node) => {
        const [nodeDescriptor, subGraph] = await node.serializeNode();
        if (subGraph) graphs[node.id] = subGraph;
        return nodeDescriptor;
      })
    );

    const edges = queue.flatMap((node) =>
      node.outgoing.map((edge) => ({
        from: edge.from.id,
        to: edge.to.id,
        out: edge.out,
        in: edge.in,
        ...(edge.constant ? { constant: true } : {}),
      }))
    );

    return { ...metadata, edges, nodes, graphs };
  }

  // TODO:BASE, this is needed for our syntax so that it can call handlers in
  // serialization mode. Should this be part of the base class? Probably not.
  serializing() {
    return this.#config.serialize;
  }

  #findAllConnectedNodes(node: NodeImpl) {
    const nodes = new Set<NodeImpl>();
    const queue = [node.unProxy()];

    while (queue.length) {
      const node = queue.shift() as NodeImpl;
      if (nodes.has(node)) continue;
      nodes.add(node);
      node.incoming.forEach((edge) => queue.push(edge.from.unProxy()));
      node.outgoing.forEach((edge) => queue.push(edge.to.unProxy()));
    }

    return [...nodes];
  }
}

/**
 * Implements the current API, so that we can run in existing Breadboard
 * environments.
 */
export class BoardRunner implements BreadboardRunner {
  kits: Kit[] = []; // No-op for now
  edges: Edge[] = [];
  nodes: NodeDescriptor[] = [];
  args?: OriginalInputValues;

  #runner: Runner;
  #anyNode?: NodeImpl;

  constructor() {
    // Initialize Runner is call context of where the board is created
    this.#runner = new Runner([getCurrentContextRunner()]);
  }

  async *run({
    probe,
    kits,
  }: NodeHandlerContext): AsyncGenerator<BreadboardRunResult> {
    const runner = new Runner([this.#runner], { probe });
    kits?.forEach((kit) => runner.addHandlers(handlersFromKit(kit)));
    for await (const result of runner.run(this.#anyNode as NodeImpl))
      yield result;
  }

  // This is mostly copy & pasted from the original
  async runOnce(
    inputs: OriginalInputValues,
    context?: NodeHandlerContext
  ): Promise<OriginalOutputValues> {
    const args = { ...inputs, ...this.args };

    try {
      let outputs: OriginalOutputValues = {};

      for await (const result of this.run(context ?? {})) {
        if (result.type === "input") {
          // Pass the inputs to the board. If there are inputs bound to the board
          // (e.g. from a lambda node that had incoming wires), they will
          // overwrite supplied inputs.
          result.inputs = args;
        } else if (result.type === "output") {
          outputs = result.outputs;
          // Exit once we receive the first output.
          break;
        }
      }
      return outputs;
    } catch (e) {
      // Unwrap unhandled error (handled errors are just outputs of the board!)
      if ((e as { cause: string }).cause)
        return Promise.resolve({
          $error: (e as { cause: string }).cause,
        } as OriginalOutputValues);
      else throw e;
    }
  }

  addValidator(_: BreadboardValidator): void {
    // TODO: Implement
  }

  static async fromNode(
    node: NodeImpl,
    metadata?: GraphMetadata
  ): Promise<BoardRunner> {
    const board = new BoardRunner();
    Object.assign(board, await node.serialize(metadata));
    board.#anyNode = node;
    return board;
  }

  static async fromGraphDescriptor(
    graph: GraphDescriptor
  ): Promise<BoardRunner> {
    const board = new BoardRunner();
    board.nodes = graph.nodes;
    board.edges = graph.edges;
    board.args = graph.args;

    const nodes = new Map<string, NodeImpl>();
    graph.nodes.forEach((node) => {
      const newNode = new NodeImpl(
        node.type,
        board.#runner,
        node.configuration as InputValues
      );
      nodes.set(node.id, newNode);
      if (!board.#anyNode) board.#anyNode = newNode;
    });

    graph.edges.forEach((edge) => {
      const newEdge = {
        from: nodes.get(edge.from),
        to: nodes.get(edge.to),
        out: edge.out,
        in: edge.in,
        constant: edge.constant,
      } as EdgeImpl;
      newEdge.from.outgoing.push(newEdge);
      newEdge.to.incoming.push(newEdge);
    });

    return board;
  }

  static async load(
    url: string,
    options?: {
      base?: string;
      outerGraph?: GraphDescriptor;
    }
  ): Promise<BoardRunner> {
    const graph = await OriginalBoardRunner.load(url, options);
    const board = await BoardRunner.fromGraphDescriptor(graph);
    return board;
  }
}

/**
 * The following is inspired by zone.js, but much simpler, and crucially doesn't
 * require monkey patching.
 *
 * Instead, we use a global variable to store the current runner, and swap it
 * out when we need to run a function in a different context.
 *
 * Runner.asRunnerFor() wraps a function that runs with that Runner as context.
 *
 * flow and any nodeFactory will run with the current Runner as context.
 *
 * Crucially (and that's all we need from zone.js), {NodeImpl,Value}.then() call
 * onsuccessful and onrejected with the Runner as context. So even if the
 * context changed in the meantime, due to async calls, the rest of a flow
 * defining function will run with the current Runner as context.
 *
 * This works because NodeImpl and Value are PromiseLike, and so their then() is
 * called when they are awaited. Importantly, there is context switch between
 * the await call and entering then(), and there is no context switch between
 * then() and the onsuccessful or onrejected call.
 *
 * One requirement from this that there can't be any await in the body of a flow
 * or action function, if they are followed by either node creation or flow
 * calls. This is also a requirement for restoring state after interrupting a
 * flow.
 */

// Initialize with a default global Runner.
let currentContextRunner = new Runner();

function getCurrentContextRunner() {
  const runner = currentContextRunner;
  if (!runner) throw Error("No runner found in context");
  return runner;
}

function swapCurrentContextRunner(runner: Runner) {
  const oldRunner = currentContextRunner;
  currentContextRunner = runner;
  return oldRunner;
}

// Create the base kit:

const reservedWord: NodeHandlerFunction<
  InputValues,
  OutputValues
> = async () => {
  throw new Error("Reserved word handler should never be invoked");
};

// These get added to the default runner defined above
export const base = {
  input: addNodeType("input", reservedWord),
  output: addNodeType("output", reservedWord),
};

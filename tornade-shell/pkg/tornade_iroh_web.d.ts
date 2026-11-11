/* tslint:disable */
/* eslint-disable */
/**
 * The `ReadableStreamType` enum.
 *
 * *This API requires the following crate features to be activated: `ReadableStreamType`*
 */

export type ReadableStreamType = "bytes";

export class IntoUnderlyingByteSource {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    cancel(): void;
    pull(controller: ReadableByteStreamController): Promise<any>;
    start(controller: ReadableByteStreamController): void;
    readonly autoAllocateChunkSize: number;
    readonly type: ReadableStreamType;
}

export class IntoUnderlyingSink {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    abort(reason: any): Promise<any>;
    close(): Promise<any>;
    write(chunk: any): Promise<any>;
}

export class IntoUnderlyingSource {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    cancel(): void;
    pull(controller: ReadableStreamDefaultController): Promise<any>;
}

export class Link {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    endpoint_id(): string;
    fetch(method: string, path: string, headers: Array<any>, body?: Uint8Array | null): Promise<any>;
    websocket(path: string): Promise<any>;
}

export class Socket {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    close(code: number, reason: string): Promise<any>;
    next(): Promise<any>;
    send_binary(data: Uint8Array): Promise<any>;
    send_text(text: string): Promise<any>;
}

export function connect(owner: string, relay?: string | null): Promise<Link>;

export function device_id(): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_intounderlyingbytesource_free: (a: number, b: number) => void;
    readonly __wbg_intounderlyingsink_free: (a: number, b: number) => void;
    readonly __wbg_intounderlyingsource_free: (a: number, b: number) => void;
    readonly __wbg_link_free: (a: number, b: number) => void;
    readonly __wbg_socket_free: (a: number, b: number) => void;
    readonly connect: (a: number, b: number, c: number, d: number) => any;
    readonly device_id: () => [number, number, number, number];
    readonly intounderlyingbytesource_autoAllocateChunkSize: (a: number) => number;
    readonly intounderlyingbytesource_cancel: (a: number) => void;
    readonly intounderlyingbytesource_pull: (a: number, b: any) => any;
    readonly intounderlyingbytesource_start: (a: number, b: any) => void;
    readonly intounderlyingbytesource_type: (a: number) => number;
    readonly intounderlyingsink_abort: (a: number, b: any) => any;
    readonly intounderlyingsink_close: (a: number) => any;
    readonly intounderlyingsink_write: (a: number, b: any) => any;
    readonly intounderlyingsource_cancel: (a: number) => void;
    readonly intounderlyingsource_pull: (a: number, b: any) => any;
    readonly link_endpoint_id: (a: number) => [number, number];
    readonly link_fetch: (a: number, b: number, c: number, d: number, e: number, f: any, g: number, h: number) => any;
    readonly link_websocket: (a: number, b: number, c: number) => any;
    readonly socket_close: (a: number, b: number, c: number, d: number) => any;
    readonly socket_next: (a: number) => any;
    readonly socket_send_binary: (a: number, b: number, c: number) => any;
    readonly socket_send_text: (a: number, b: number, c: number) => any;
    readonly ring_core_0_17_14__bn_mul_mont: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly wasm_bindgen_4aa94627c470bcf4___convert__closures_____invoke___js_sys_26f2c7355a4b2907___Function_fn_wasm_bindgen_4aa94627c470bcf4___JsValue_____wasm_bindgen_4aa94627c470bcf4___sys__Undefined___js_sys_26f2c7355a4b2907___Function_fn_wasm_bindgen_4aa94627c470bcf4___JsValue_____wasm_bindgen_4aa94627c470bcf4___sys__Undefined_______true_: (a: number, b: number, c: any, d: any) => void;
    readonly wasm_bindgen_4aa94627c470bcf4___convert__closures_____invoke___wasm_bindgen_4aa94627c470bcf4___JsValue__core_37ee0ce0c4cd57d5___result__Result_____wasm_bindgen_4aa94627c470bcf4___JsError___true_: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen_4aa94627c470bcf4___convert__closures_____invoke___wasm_bindgen_4aa94627c470bcf4___JsValue______true_: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen_4aa94627c470bcf4___convert__closures_____invoke___web_sys_bb92c2f6245e6378___features__gen_CloseEvent__CloseEvent______true_: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen_4aa94627c470bcf4___convert__closures_____invoke___web_sys_bb92c2f6245e6378___features__gen_MessageEvent__MessageEvent______true_: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen_4aa94627c470bcf4___convert__closures_____invoke_______true_: (a: number, b: number) => void;
    readonly wasm_bindgen_4aa94627c470bcf4___convert__closures_____invoke_______true__1_: (a: number, b: number) => void;
    readonly wasm_bindgen_4aa94627c470bcf4___convert__closures_____invoke_______true__2_: (a: number, b: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_destroy_closure: (a: number, b: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;

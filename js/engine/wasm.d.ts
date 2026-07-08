// Vite's `?url` asset import for the committed WASM binary.
declare module '*.wasm?url' {
  const url: string;
  export default url;
}

/** Metro resolves an imported image to an asset id that `<Image source>` takes. */
declare module '*.png' {
  const asset: number;
  export = asset;
}

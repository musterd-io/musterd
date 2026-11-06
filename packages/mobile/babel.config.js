// ADR 815: the worklets plugin lets reanimated run animation code on the UI thread. It must be the
// last plugin, as its own docs require, so nothing rewrites a worklet after it is marked.
module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    plugins: ['react-native-worklets/plugin'],
  };
};

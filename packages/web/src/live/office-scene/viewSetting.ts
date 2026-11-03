/**
 * The three panoramas outside the office windows (window views). Its own import-free module so the
 * /live header's "Outside" button (eager) can name them without pulling the scene (lazy) along.
 */
export type ViewSetting = 'city' | 'coast' | 'mountain';
export const DEFAULT_VIEW: ViewSetting = 'city';
export const VIEW_SETTINGS: readonly ViewSetting[] = ['city', 'coast', 'mountain'];

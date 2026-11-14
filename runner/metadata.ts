/** Wire metadata bounds mirror Worker execution/router.ts and execution/hub.ts. */
export const DEVICE_NAME_MAX = 100;
export const WORKSPACE_NAME_MAX = 100;
export const WORKSPACE_PATH_MAX = 1024;
export const WORKSPACE_COUNT_MAX = 100;
export const WORKSPACE_CHECK_COUNT_MAX = 50;
export const CHECK_LABEL_MAX = 100;
export const validMetadataId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
export const validDeviceName = (value: unknown): value is string =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value.length <= DEVICE_NAME_MAX;

// Shared by the native evidence exporter and the model-input/write validators.
export function hasSecretText(value) {
  const text = String(value).replace(/\\"/g, '"');
  return /(?:sk-[a-z0-9_-]{12,}|bearer\s+\S{8,}|(?:api[_ -]?key|password|secret|token|密码|密钥|私钥)["']?\s*(?:[:=：]|(?:是|为|设为|使用)|\bis\b)\s*["']?\S+|-----BEGIN .*PRIVATE KEY|qd_session=|\beyJ[a-z0-9_-]{15,}\.[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}\b|[?&](?:sig|signature|access_token|x-amz-signature)=[^&\s]+)/iu.test(
    text,
  );
}

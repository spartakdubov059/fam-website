const DEFAULT_API_URL = "http://127.0.0.1:8080/v1/chat/completions";

export function resolveLocalModelApiUrl(value = DEFAULT_API_URL) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Local model API URL is invalid.");
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.port === "" ||
    url.pathname !== "/v1/chat/completions" ||
    url.username || url.password || url.search || url.hash
  ) {
    throw new Error("Local model API must use the loopback chat-completions endpoint.");
  }
  return url.href;
}

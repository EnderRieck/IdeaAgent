import { ProxyAgent, setGlobalDispatcher } from "undici";

let initialized = false;

export function setupGlobalProxy(): void {
  if (initialized) {
    return;
  }
  initialized = true;

  const proxyUrl =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy;

  if (!proxyUrl) {
    return;
  }

  const normalized = proxyUrl.startsWith("socks")
    ? proxyUrl.replace(/^socks5h?:\/\//, "http://")
    : proxyUrl;

  setGlobalDispatcher(new ProxyAgent(normalized));
}

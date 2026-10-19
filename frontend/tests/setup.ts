import "@testing-library/jest-dom/vitest";
import { resetApiClient } from "../src/api";

HTMLDialogElement.prototype.showModal ||= function (this: HTMLDialogElement) {
  this.setAttribute("open", "");
};
HTMLDialogElement.prototype.close ||= function (this: HTMLDialogElement) {
  this.removeAttribute("open");
};

const nativeFetch = globalThis.fetch.bind(globalThis);
const cookieJar = new Map<string, string>();
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const requestUrl = new URL(
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
  );
  const requestHeaders = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers).forEach((value, key) => requestHeaders.set(key, value));
  if (requestUrl.hostname === "127.0.0.1" && requestUrl.port === "3200" && cookieJar.size) {
    requestHeaders.set("Cookie", [...cookieJar].map(([name, value]) => `${name}=${value}`).join("; "));
  }
  const response = await nativeFetch(input, { ...init, headers: requestHeaders });
  const getSetCookie = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  const values = getSetCookie ? getSetCookie.call(response.headers) : [];
  for (const setCookie of values) {
    const first = setCookie.split(";", 1)[0];
    const separator = first.indexOf("=");
    if (separator < 0) continue;
    const name = first.slice(0, separator);
    const value = first.slice(separator + 1);
    if (value) cookieJar.set(name, value);
    else cookieJar.delete(name);
  }
  return response;
};

afterEach(() => {
  sessionStorage.clear();
  cookieJar.clear();
  resetApiClient();
});

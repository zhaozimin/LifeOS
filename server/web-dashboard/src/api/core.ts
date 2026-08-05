/**
 * [INPUT]: 依赖浏览器 URL、localStorage、Fetch API 与 LifeOS 单一 Bearer Token 约定。
 * [OUTPUT]: 提供共享 HTTP 传输、Token 生命周期、URL Token 消费和同源旧客户端卫生处理。
 * [POS]: 统一面板唯一网络与认证边界；time.ts 与 fin.ts 只描述各自领域端点。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

export const TOKEN_STORAGE_KEY = "lifeos-token";

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export type QueryValue = string | number | boolean | undefined | null;
export type RequestOptions = {
  body?: unknown;
  params?: Record<string, QueryValue>;
  signal?: AbortSignal;
};

export function getToken(): string {
  return localStorage.getItem(TOKEN_STORAGE_KEY) || "";
}

export function setToken(token: string): void {
  const clean = token.trim();
  if (clean) localStorage.setItem(TOKEN_STORAGE_KEY, clean);
  else localStorage.removeItem(TOKEN_STORAGE_KEY);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_STORAGE_KEY);
}

export function isAbortError(caught: unknown): boolean {
  return caught instanceof DOMException && caught.name === "AbortError";
}

export function consumeUrlToken(): boolean {
  const url = new URL(window.location.href);
  const token = url.searchParams.get("token") || url.searchParams.get("access_token");
  if (!token) return false;
  setToken(token);
  url.searchParams.delete("token");
  url.searchParams.delete("access_token");
  window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  return true;
}

/**
 * LifeOS 与旧 FinOS 同源发布时的首帧清理。失败均是非致命的浏览器能力降级，
 * 不允许影响登录门；新壳不会注册 Service Worker。
 */
export async function cleanLegacyBrowserState(): Promise<void> {
  const legacyTheme = localStorage.getItem("finance-theme");
  if (legacyTheme && !localStorage.getItem("lifeos-theme")) localStorage.setItem("lifeos-theme", legacyTheme);
  localStorage.removeItem("finance-theme");
  localStorage.removeItem("finance-node-token");
  if (!("serviceWorker" in navigator)) return;
  try {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.map((registration) => registration.unregister()));
    const cacheKeys = await caches.keys();
    await Promise.all(cacheKeys.map((key) => caches.delete(key)));
  } catch {
    // 某些受限浏览器禁止 Cache API；不把卫生降级变成不可登录故障。
  }
}

function buildUrl(path: string, params?: Record<string, QueryValue>): string {
  const url = new URL(path, window.location.origin);
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  return url.pathname + url.search;
}

export async function request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  let response: Response;
  try {
    response = await fetch(buildUrl(path, options.params), {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });
  } catch (caught) {
    if (isAbortError(caught)) throw caught;
    throw new ApiError(0, "无法连接本机 LifeOS 服务。请确认它已启动，然后重试。");
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload && typeof payload === "object" && "message" in payload
      ? String((payload as { message: string }).message)
      : `${method} ${path} 请求失败（${response.status}）`;
    if (response.status === 401) clearToken();
    throw new ApiError(response.status, message, payload);
  }
  return payload as T;
}

export async function requestBlob(method: string, path: string, options: Omit<RequestOptions, "body"> = {}): Promise<Response> {
  const token = getToken();
  let response: Response;
  try {
    response = await fetch(buildUrl(path, options.params), {
      method,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: options.signal,
    });
  } catch (caught) {
    if (isAbortError(caught)) throw caught;
    throw new ApiError(0, "无法连接本机 LifeOS 服务。请确认它已启动，然后重试。");
  }
  if (!response.ok) {
    if (response.status === 401) clearToken();
    throw new ApiError(response.status, `${method} ${path} 请求失败（${response.status}）`);
  }
  return response;
}

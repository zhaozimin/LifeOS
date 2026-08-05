/**
 * [INPUT]: 依赖 TimeOS API 客户端的 token 存储与健康检查。
 * [OUTPUT]: 对外提供本地访问密钥登录门，分辨 401 与网络不可达，验证成功后把 health（含记录时区）交给 App。
 * [POS]: components 的认证边界；候选密钥验证失败时恢复原凭证，只有 401 被呈现为密钥错误。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import { useState, type FormEvent } from "react";
import { ArrowRight, HeartPulse } from "lucide-react";
import { api, ApiError, getToken, setToken } from "../api/client";
import type { Health } from "../types";

export function TokenGate({ onAuthenticated }: { onAuthenticated: (health: Health) => void }) {
  const [token, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!token.trim()) return;
    setBusy(true);
    setError("");
    const previousToken = getToken();
    setToken(token);
    try {
      const health = await api.health();
      onAuthenticated(health);
    } catch (caught) {
      setToken(previousToken);
      setError(caught instanceof ApiError && caught.status === 401
        ? "访问密钥无效，请核对部署时交付的连接信息。"
        : "本机 TimeOS 服务暂时不可达。原有密钥已保留，请启动服务后重试。");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-5 text-foreground">
      <section className="w-full max-w-md rounded-xl border border-border bg-card p-7 shadow-xl">
        <div className="mb-6 flex items-center gap-3">
          <span className="inline-flex h-11 w-11 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <HeartPulse size={24} />
          </span>
          <div>
            <h1 className="serif text-2xl">LifeOS</h1>
            <p className="text-sm text-muted-foreground">本地人生账本</p>
          </div>
        </div>
        <p className="mb-5 text-sm leading-6 text-muted-foreground">
          输入本机部署生成的访问密钥。密钥只保存在当前浏览器，不会发送到 LifeOS 之外。
        </p>
        <form onSubmit={submit} className="space-y-3">
          <label className="block text-xs font-semibold tracking-wide text-muted-foreground">
            访问密钥
            <input
              autoFocus
              type="password"
              value={token}
              onChange={(event) => setValue(event.target.value)}
              className="mt-2 h-11 w-full rounded-md border border-border bg-background px-3 font-mono text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/25"
              placeholder="粘贴 accessToken"
            />
          </label>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <button
            type="submit"
            disabled={busy || !token.trim()}
            className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-md bg-primary text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            {busy ? "正在验证…" : "进入 LifeOS"}<ArrowRight size={16} />
          </button>
        </form>
      </section>
    </main>
  );
}

/**
 * [INPUT]: 依赖 api/client 的 fetchAttachmentBlob。
 * [OUTPUT]: 对外提供 AuthedImage —— 用 Bearer 头拉取附件为 Blob 并以 object URL 渲染 <img>。
 * [POS]: 附件预览的统一入口（灯箱/编辑抽屉/发票工作台）；替代把 token 拼进 <img src> 的旧做法，
 *   杜绝凭证泄漏到浏览器历史/磁盘缓存/服务器日志/Referer。卸载即 revokeObjectURL 释放。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useEffect, useState } from "react";
import { api } from "../api/client";

export function AuthedImage({
  id,
  alt,
  className,
  draggable = false,
}: {
  id: string;
  alt: string;
  className?: string;
  draggable?: boolean;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let revoked = false;
    let objUrl: string | null = null;
    setUrl(null);
    setFailed(false);
    api
      .fetchAttachmentBlob(id)
      .then((blob) => {
        if (revoked) return;
        objUrl = URL.createObjectURL(blob);
        setUrl(objUrl);
      })
      .catch(() => {
        if (!revoked) setFailed(true);
      });
    return () => {
      revoked = true;
      if (objUrl) URL.revokeObjectURL(objUrl);
    };
  }, [id]);

  if (failed) {
    return (
      <div className={className} style={{ display: "grid", placeItems: "center", minHeight: 48 }}>
        <span className="text-[12px] text-muted-foreground">加载失败</span>
      </div>
    );
  }
  if (!url) {
    return <div className={`${className || ""} animate-pulse bg-muted`} style={{ minHeight: 48 }} aria-busy />;
  }
  return <img src={url} alt={alt} className={className} draggable={draggable} />;
}

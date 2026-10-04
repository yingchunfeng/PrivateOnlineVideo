import { useEffect, useMemo, useState } from "react";
import type { EmailChallenge, EmailProviderType } from "@online-video/shared";

export function EmailProviderHint({ providers }: { providers: readonly EmailProviderType[] }) {
  return <small className="muted">{providers.length ? `支持 ${providers.map(provider => `${provider.name}（@${provider.domain}）`).join(" 和 ")}。` : "暂未启用可绑定的邮箱类型，请联系站点管理者。"}</small>;
}

type VerificationWindow = { serverTime: string; expiresAt: string; resendAt?: string };
export function useVerificationClock(value: VerificationWindow | undefined) {
  const reference = useMemo(() => value ? { serverTime: Date.parse(value.serverTime), receivedAt: performance.now() } : undefined, [value]);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!value) return;
    const timer = window.setInterval(() => tick(current => current + 1), 500);
    return () => window.clearInterval(timer);
  }, [value]);
  const serverNow = reference ? reference.serverTime + performance.now() - reference.receivedAt : 0;
  return {
    expired: !!value && Date.parse(value.expiresAt) <= serverNow,
    remaining: value ? Math.max(0, Math.ceil((Date.parse(value.expiresAt) - serverNow) / 1000)) : 0,
    cooldown: value?.resendAt ? Math.max(0, Math.ceil((Date.parse(value.resendAt) - serverNow) / 1000)) : 0
  };
}

export function EmailCodeField({ challenge, code, onChange, disabled, label = "邮箱验证码" }: { challenge: EmailChallenge; code: string; onChange: (value: string) => void; disabled: boolean; label?: string }) {
  const clock = useVerificationClock(challenge);
  return <><div className={`notice ${clock.expired ? "warning" : ""}`} role="status"><strong>{clock.expired ? "验证码已过期，请重新发送" : `验证码已发送至 ${challenge.maskedEmail}`}</strong>{!clock.expired && <small>有效期还剩 {clock.remaining} 秒；邮件可能需要稍等片刻。</small>}</div><label>{label}<input autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} value={code} onChange={event => onChange(event.target.value.replace(/\D/g, ""))} required disabled={disabled || clock.expired} /></label></>;
}

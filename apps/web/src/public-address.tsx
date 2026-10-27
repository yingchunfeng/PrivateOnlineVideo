import { publicMediaUrl } from "./library-data";
import type { PublicMediaPolicy } from "./library-data";
import { ErrorNotice } from "./ui";
import { useFeedback } from "./feedback";

export function PublicAddress({ publicUrl, library }: { publicUrl: string | undefined; library: PublicMediaPolicy | undefined }) {
  const { toast, toastError } = useFeedback();
  if (!publicUrl) return <div className="notice">此记录尚无公共地址，请核对已登记的对象路径。</div>;
  let source: string;
  try { source = publicMediaUrl(publicUrl, library); } catch (err) { return <ErrorNotice error={err} />; }
  return <div className="stack"><label>公共地址<input aria-label="公共地址" readOnly value={source} onFocus={event => event.currentTarget.select()} /></label><div className="actions"><a className="button secondary" href={source} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">打开原地址</a><button className="secondary" onClick={async () => { try { await navigator.clipboard.writeText(source); toast("公共地址已复制"); } catch { toastError(new Error("浏览器未允许复制，请选中公共地址手动复制。")); } }}>复制公共地址</button></div></div>;
}

/* Lead-owned shell: Calendly-B sidebar + top bar. Pages render inside .ml-content.
   `?embed=1` (Chrome extension side panel iframes) hides the shell — see EmbedMode in Nav.tsx. */
import "./globals.css";
import { Suspense, type ReactNode } from "react";
import { Sidebar, TopBar, EmbedMode } from "./Nav";
export const metadata = { title: "Git CRM — PRs for your CRM agents" };
// Runs before any app JS. When embedded: set data-embed before first paint (no sidebar flash), and
// shim EventSource so every subscriber in this frame shares ONE /api/stream connection that is
// closed while the side panel shows another tab (it posts {type:"gitcrm:visible"}). Without this,
// several iframes x several streams exhaust Chrome's 6-connections-per-host limit on HTTP/1.1.
const EMBED_BOOT = `(function(){try{
var q=/[?&]embed=([01])(&|$)/.exec(location.search);var on=q?q[1]==="1":sessionStorage.getItem("gitcrm:embed")==="1";
if(!on||!window.EventSource)return;document.documentElement.dataset.embed="1";
var Real=window.EventSource,subs=[],cur=null,curUrl=null,visible=true;
function fire(e){subs.slice().forEach(function(s){try{s.onmessage&&s.onmessage(e)}catch(x){}})}
function start(){if(cur||!visible||!subs.length)return;cur=new Real(curUrl);cur.onmessage=fire}
function stop(){if(cur){cur.close();cur=null}}
function ES(url){this.url=String(url);this.readyState=1;this.onmessage=null;this.onerror=null;this.onopen=null;curUrl=curUrl||this.url;subs.push(this);start()}
ES.prototype.close=function(){this.readyState=2;var i=subs.indexOf(this);if(i>=0)subs.splice(i,1);if(!subs.length)stop()};
ES.prototype.addEventListener=function(){};ES.prototype.removeEventListener=function(){};
ES.CONNECTING=0;ES.OPEN=1;ES.CLOSED=2;window.EventSource=ES;
window.addEventListener("message",function(e){var d=e.data;if(!d||d.type!=="gitcrm:visible")return;
if(d.visible){if(!visible){visible=true;start();fire(new MessageEvent("message",{data:"resume"}))}}else{visible=false;stop()}});
}catch(e){}})()`;
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning><head><script dangerouslySetInnerHTML={{ __html: EMBED_BOOT }} /></head><body>
      <Suspense fallback={null}><EmbedMode /></Suspense>
      <div className="ml-shell">
        <Sidebar />
        <div className="ml-main">
          <TopBar />
          <main className="ml-content">{children}</main>
        </div>
      </div>
    </body></html>
  );
}

/* 启动画面的计时起点。
 *
 * 这段原来写在 index.html 的内联 <script> 里，但页面的 CSP 是 `script-src 'self'`，
 * 内联脚本会被浏览器直接拒绝（控制台一直报 CSP 违规，启动计时也拿不到真实起点）。
 * 审计 2026-11-09：挪成独立文件，既符合 CSP 又保持"越早执行越好"。
 */
window.__phSplashStartedAt = Date.now();

// 【本 fork 已移除渲染】侧边栏左下角的 5 个推广入口：捐赠 / 官网 / GitHub / 微信二维码 / X。
// 组件本身保留在仓库里（日后想恢复只需在 workspace-sidebar-nav.tsx 里加回一次调用），
// 但对外分发的版本不再展示这些指向上游作者与官网的入口。
import { Popover, Tooltip } from "antd";
import { Globe, HandHeart, Star } from "lucide-react";
import Github from "@lobehub/icons/es/Github";
import { getDesktopAppBinding } from "@/services/desktop-runtime";

const WECHAT_ICON_PATH = "M8.691 2.188C3.891 2.188 0 5.476 0 9.53c0 2.212 1.17 4.203 3.002 5.55a.59.59 0 0 1 .213.665l-.39 1.48c-.019.07-.048.141-.048.213 0 .163.13.295.29.295a.326.326 0 0 0 .167-.054l1.903-1.114a.864.864 0 0 1 .717-.098 10.16 10.16 0 0 0 2.837.403c.276 0 .543-.027.811-.05-.857-2.578.157-4.972 1.932-6.446 1.703-1.415 3.882-1.98 5.853-1.838-.576-3.583-4.196-6.348-8.596-6.348zM5.785 5.991c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178A1.17 1.17 0 0 1 4.623 7.17c0-.651.52-1.18 1.162-1.18zm5.813 0c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178 1.17 1.17 0 0 1-1.162-1.178c0-.651.52-1.18 1.162-1.18zm5.34 2.867c-1.797-.052-3.746.512-5.28 1.786-1.72 1.428-2.687 3.72-1.78 6.22.942 2.453 3.666 4.229 6.884 4.229.826 0 1.622-.12 2.361-.336a.722.722 0 0 1 .598.082l1.584.926a.272.272 0 0 0 .14.047c.134 0 .24-.111.24-.247 0-.06-.023-.12-.038-.177l-.327-1.233a.582.582 0 0 1-.023-.156.49.49 0 0 1 .201-.398C23.024 18.48 24 16.82 24 14.98c0-3.21-2.931-5.837-6.656-6.088V8.89c-.135-.01-.27-.027-.407-.03zm-2.53 3.274c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.982.97-.982zm4.844 0c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.982.969-.982z";
const X_ICON_PATH = "M18.901 2H22l-6.77 7.737L23.196 22h-6.238l-4.886-7.434L5.567 22H2.465l7.241-8.277L1.804 2h6.396l4.417 6.743L18.901 2Zm-1.087 18h1.716L7.266 3.895H5.425L17.814 20Z";

export function WorkspaceSidebarSocialLinks() {
    const openGitHub = async (event: React.MouseEvent<HTMLAnchorElement>) => {
        const openInBrowser = getDesktopAppBinding()?.OpenBeefTVGitHub;
        if (!openInBrowser) return;
        event.preventDefault();
        await openInBrowser();
    };
    const openWebsite = async (event: React.MouseEvent<HTMLAnchorElement>) => {
        const openInBrowser = getDesktopAppBinding()?.OpenBeefTVWebsite;
        if (!openInBrowser) return;
        event.preventDefault();
        await openInBrowser();
    };
    const openX = async (event: React.MouseEvent<HTMLAnchorElement>) => {
        const openInBrowser = getDesktopAppBinding()?.OpenBeefTVX;
        if (!openInBrowser) return;
        event.preventDefault();
        await openInBrowser();
    };

    return (
        <div className="app-workspace-social-links">
            <Popover
                trigger="hover"
                placement="top"
                arrow={false}
                mouseEnterDelay={0}
                mouseLeaveDelay={0}
                rootClassName="app-workspace-donation-popover"
                content={
                    <div className="app-workspace-donation-content">
                        <p>
                            如果觉得好用的话，欢迎捐赠支持我们！<br />
                            你的支持是我们不断优化迭代BeefTV的最大动力
                        </p>
                        <img src="/beeftv-donation-qr.png" width={294} height={286} alt="博文斯科技官方收款二维码" />
                    </div>
                }
            >
                <button type="button" className="app-workspace-social-action" aria-label="捐赠支持 BeefTV">
                    <HandHeart aria-hidden="true" />
                </button>
            </Popover>
            <a className="app-workspace-social-action" href="https://beeftv.app/" target="_blank" rel="noopener noreferrer" aria-label="打开 BeefTV 官网" title="BeefTV 官网" onClick={openWebsite}>
                <Globe aria-hidden="true" />
            </a>
            <Tooltip
                placement="top"
                trigger={["hover", "focus"]}
                mouseEnterDelay={0.15}
                mouseLeaveDelay={0.1}
                rootClassName="app-workspace-github-tooltip"
                title={<span className="app-workspace-github-hint">点点 star <Star aria-hidden="true" /></span>}
            >
                <a className="app-workspace-social-action" href="https://github.com/glanderness/BeefTV" target="_blank" rel="noopener noreferrer" aria-label="打开 BeefTV GitHub 仓库" onClick={openGitHub}>
                    <Github aria-hidden="true" />
                </a>
            </Tooltip>
            <Popover
                trigger="hover"
                placement="top"
                arrow={false}
                mouseEnterDelay={0}
                mouseLeaveDelay={0}
                rootClassName="app-workspace-wechat-popover"
                content={<img src="/beeftv-wechat-qr.png" width={180} height={180} alt="个人微信二维码" />}
            >
                <button type="button" className="app-workspace-social-action" aria-label="查看微信二维码">
                    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d={WECHAT_ICON_PATH} /></svg>
                </button>
            </Popover>
            <a className="app-workspace-social-action" href="https://x.com/beefnoode" target="_blank" rel="noopener noreferrer" aria-label="打开 X 主页" title="X" onClick={openX}>
                <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d={X_ICON_PATH} /></svg>
            </a>
        </div>
    );
}

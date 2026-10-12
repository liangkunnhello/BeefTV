import { ChevronLeft, ChevronRight, Home, Plug, Plus, Settings2, Sun, Moon } from "lucide-react";
import { LayoutGroup, motion, useReducedMotion } from "motion/react";
import { useEffect, useMemo, useRef, useState, type ComponentType, type CSSProperties } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";

import { BrandLogoFrame } from "@/components/brand/brand-logo";
import { WorkspaceSidebarUpdate } from "@/components/layout/workspace-sidebar-update";
import { Kbd } from "@/components/ui/base/kbd";
import { navigationTools, type NavigationToolSlug } from "@/constant/navigation-tools";
import { aceternityMotion } from "@/lib/aceternity-motion";
import { cn } from "@/lib/utils";
import { preloadWorkspaceRoute } from "@/lib/workspace-route-modules";
import { useUserStore, type FeatureAvailability } from "@/stores/use-user-store";
import { useAppearanceStore } from "@/stores/use-appearance-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { AnimatedThemeToggler } from "@/components/ui/animated-theme-toggler";

export type WorkspaceNavItem = {
    id: string;
    title: string;
    icon?: ComponentType<{ className?: string; strokeWidth?: number }>;
    to?: string;
    shortcut?: string;
    badge?: string | number;
    disabled?: boolean;
    action?: "search";
    children?: WorkspaceNavItem[];
};

type WorkspaceNavGroup = {
    heading?: string;
    items: WorkspaceNavItem[];
};

function toolItem(slug: NavigationToolSlug, to: string): WorkspaceNavItem {
    const tool = navigationTools.find((item) => item.slug === slug);
    return { id: slug, title: tool?.label ?? slug, icon: tool?.icon, to };
}

function buildNav(features: FeatureAvailability): { groups: WorkspaceNavGroup[]; footer: WorkspaceNavItem[] } {
    const groups: WorkspaceNavGroup[] = [
        {
            items: [
                { id: "new", title: "新建项目", icon: Plus, to: "/canvas?mode=new" },
            ],
        },
        {
            items: [
                { id: "home", title: "首页", icon: Home, to: "/" },
                { ...toolItem("canvas", "/project"), title: "项目" },
                { ...toolItem("assets", "/assets"), title: "资产" },
                { id: "settings:channels", title: "模型配置", icon: Settings2, to: "/settings?section=channels" },
                { id: "agents", title: "BeefTV MCP", icon: Plug, to: "/agents" },
            ],
        },
    ];

    // 管理、设置和退出登录不再占据参考站式侧栏底部，而是通过用户卡片菜单进入。
    // 路由和写操作仍保留，避免把用户端导航变成无法访问的装饰。
    return { groups, footer: [] };
}

function WorkspaceSwitcher({ collapsed, onNavigate, onExpand, onCollapse }: { collapsed: boolean; onNavigate: () => void; onExpand: () => void; onCollapse: () => void }) {
    const appearance = useAppearanceStore((state) => state.appearance);

    if (collapsed) {
        return (
            <div className="app-workspace-sidebar-rail-header shrink-0">
                <button type="button" className="app-workspace-sidebar-rail-button" aria-label="展开侧栏菜单" title="展开侧栏菜单" onClick={onExpand}>
                    <ChevronRight className="size-4" strokeWidth={1.7} />
                </button>
            </div>
        );
    }

    return (
        <div className="app-workspace-sidebar-brand-row relative shrink-0 px-3 pt-3">
            <Link to="/" onClick={onNavigate} className="app-workspace-sidebar-brand-button group" aria-label={`${appearance.brandName}首页`}>
                <span className="flex min-w-0 items-center gap-2">
                    <BrandLogoFrame className="app-workspace-brand-mark grid size-8 shrink-0 place-items-center rounded-[var(--r-sm)] shadow-sm" logoClassName="size-5 object-contain" alt="" fallback={<span className="app-workspace-brand-placeholder" aria-hidden>B</span>} />
                    <span className="flex min-w-0">
                        <span className="app-workspace-brand-wordmark truncate text-[var(--fs-body)] leading-none font-semibold">{appearance.brandName}</span>
                    </span>
                </span>
            </Link>
            <button type="button" className="app-workspace-sidebar-collapse-button" aria-label="收起侧栏" title="收起侧栏" onClick={onCollapse}>
                <ChevronLeft className="size-4" strokeWidth={1.7} />
            </button>
        </div>
    );
}

function NavItem({
    item,
    activeId,
    onSelect,
    onOpenSearch,
    level = 0,
    collapsed = false,
}: {
    item: WorkspaceNavItem;
    activeId: string;
    onSelect: (id: string) => void;
    onOpenSearch: () => void;
    level?: number;
    collapsed?: boolean;
}) {
    const isActive = activeId === item.id || (item.id === "settings" && activeId.startsWith("settings:"));
    const hasChildren = Boolean(item.children?.length);
    const [isOpen, setIsOpen] = useState(false);
    const reducedMotion = useReducedMotion();

    // 激活分支自动展开（如设置分区子项），保证当前位置可见。
    useEffect(() => {
        if (isActive && hasChildren) setIsOpen(true);
    }, [isActive, hasChildren]);

    const Icon = item.icon;
    const rowStyle = collapsed ? undefined : ({ paddingLeft: `${level * 12 + 10}px` } as CSSProperties);

    const rowContent = (
        <>
            <span className="app-workspace-nav-main flex min-w-0 items-center gap-2.5">
                {Icon ? (
                    <span className="app-workspace-nav-icon" aria-hidden>
                        <Icon className="size-4 shrink-0" strokeWidth={1.8} />
                    </span>
                ) : (
                    <span className="size-1.5 shrink-0 rounded-full bg-current opacity-40" aria-hidden />
                )}
                {!collapsed ? <span className="app-workspace-nav-title truncate">{item.title}</span> : null}
            </span>
            <span className="app-workspace-nav-meta flex shrink-0 items-center gap-2">
                {item.disabled && !collapsed ? <span className="text-[var(--fs-micro)] font-normal text-foreground/35">正在开发</span> : null}
                {item.shortcut ? (
                    <Kbd className="hidden group-hover:inline-flex">{item.shortcut}</Kbd>
                ) : null}
                {item.badge !== undefined ? <span className="flex min-w-5 items-center justify-center rounded-full bg-primary/10 px-1.5 py-0.5 text-[var(--fs-tiny)] font-medium tabular-nums text-primary">{item.badge}</span> : null}
                {hasChildren ? <ChevronRight className={cn("size-3.5 shrink-0 text-foreground/40 transition-transform duration-200", isOpen && "rotate-90")} strokeWidth={2} /> : null}
            </span>
        </>
    );

    const rowClassName = cn(
        "app-workspace-nav-link group relative isolate flex min-h-11 w-full items-center justify-between gap-2 rounded-[var(--r-md)] px-3 py-2 text-[var(--fs-body)] transition-[color,transform] duration-200 select-none",
        collapsed && "is-collapsed",
        item.disabled ? "is-disabled text-foreground/30" : isActive ? "is-active font-medium" : "text-foreground/62 hover:bg-surface-hover hover:text-foreground",
    );
    const activePill = isActive ? (
        <motion.span
            layoutId="workspace-nav-active-pill"
            className="app-workspace-nav-active-pill"
            aria-hidden
            transition={reducedMotion ? { duration: 0 } : aceternityMotion.spring.dock}
        />
    ) : null;

    const handleClick = () => {
        if (item.action === "search") {
            onOpenSearch();
            return;
        }
        if (hasChildren) {
            setIsOpen((open) => !open);
            return;
        }
        onSelect(item.id);
    };

    // 局部 const：闭包内 TS 保留窄化，供 preload 回调使用。
    const linkTo = item.to;
    const disabledLabel = item.disabled ? `${item.title}：正在开发` : undefined;

    return (
        <div className="flex w-full flex-col">
            {linkTo && !item.disabled ? (
                <Link
                    to={linkTo}
                    className={rowClassName}
                    data-nav-id={item.id}
                    style={rowStyle}
                    aria-label={collapsed ? item.title : undefined}
                    title={collapsed ? item.title : undefined}
                    onClick={handleClick}
                    onFocus={() => preloadWorkspaceRoute(linkTo)}
                    onPointerDown={() => preloadWorkspaceRoute(linkTo)}
                    onPointerEnter={() => preloadWorkspaceRoute(linkTo)}
                >
                    {activePill}
                    {rowContent}
                </Link>
            ) : item.disabled ? (
                <span className={rowClassName} data-nav-id={item.id} style={rowStyle} aria-disabled="true" title={disabledLabel}>
                    {rowContent}
                </span>
            ) : (
                <button type="button" className={rowClassName} data-nav-id={item.id} style={rowStyle} aria-label={collapsed ? item.title : undefined} title={collapsed ? item.title : undefined} onClick={handleClick} aria-expanded={hasChildren ? isOpen : undefined}>
                    {activePill}
                    {rowContent}
                </button>
            )}

            {hasChildren && !collapsed ? (
                <div className={cn("grid transition-[grid-template-rows,opacity] duration-300 ease-in-out", isOpen ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0")}>
                    <div className="relative flex min-h-0 flex-col gap-0.5 overflow-hidden pt-0.5">
                        <span className="app-workspace-nav-guide-line" style={{ left: `${(level + 1) * 12 + 12.5}px` }} />
                        {item.children!.map((child) => (
                            <NavItem key={child.id} item={child} activeId={activeId} onSelect={onSelect} onOpenSearch={onOpenSearch} level={level + 1} collapsed={false} />
                        ))}
                    </div>
                </div>
            ) : null}
        </div>
    );
}

function NavGroup({ group, activeId, onNavigate, onOpenSearch, collapsed }: { group: WorkspaceNavGroup; activeId: string; onNavigate: () => void; onOpenSearch: () => void; collapsed: boolean }) {
    const [isOpen, setIsOpen] = useState(true);
    const hasActive = group.items.some((item) => item.id === activeId || (item.id === "settings" && activeId.startsWith("settings:")));

    // 激活项所在分组自动展开，保证当前位置可见。
    useEffect(() => {
        if (hasActive) setIsOpen(true);
    }, [hasActive]);

    const content = (
        <div className="flex flex-col gap-2">
            {group.items.map((item) => (
                <NavItem key={item.id} item={item} activeId={activeId} onSelect={onNavigate} onOpenSearch={onOpenSearch} collapsed={collapsed} />
            ))}
        </div>
    );

    // 无标题分组（核心导航入口）常驻展示，不做折叠。
    if (!group.heading || collapsed) {
        return <div className="app-workspace-nav-group flex shrink-0 flex-col" data-nav-group-heading={group.heading || ""}>{content}</div>;
    }

    return (
        <div className="app-workspace-nav-group flex shrink-0 flex-col" data-nav-group-heading={group.heading}>
            <button type="button" onClick={() => setIsOpen((open) => !open)} aria-expanded={isOpen} className="app-workspace-nav-group-toggle select-none">
                <span className="app-workspace-nav-group-label">{group.heading}</span>
                <ChevronRight className={cn("size-3.5 shrink-0 text-foreground/35 transition-transform duration-200", isOpen && "rotate-90")} strokeWidth={2} />
            </button>
            <div className={cn("grid transition-[grid-template-rows,opacity] duration-300 ease-in-out", isOpen ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0")}>
                <div className="min-h-0 overflow-hidden pt-0.5">{content}</div>
            </div>
        </div>
    );
}

export function WorkspaceSidebarNav({ collapsed, onNavigate, onOpenSearch, onExpand, onCollapse }: { collapsed: boolean; onNavigate: () => void; onOpenSearch: () => void; onExpand: () => void; onCollapse: () => void }) {
    const theme = useThemeStore((state) => state.theme);
    const setTheme = useThemeStore((state) => state.setTheme);
    const { pathname } = useLocation();
    const [searchParams] = useSearchParams();
    const features = useUserStore((state) => state.features);
    const { groups, footer } = useMemo(() => buildNav(features), [features]);

    const rawSlug = pathname.split("/").filter(Boolean)[0] || "home";
    // `/project` is the LibTV-compatible alias for the existing canvas library route.
    const slug = rawSlug === "project" ? "canvas" : rawSlug;
    const section = searchParams.get("section");
    const activeId = slug === "settings" && section ? `settings:${section}` : slug;

    const scrollRef = useRef<HTMLDivElement>(null);
    const [scrollState, setScrollState] = useState({ hasTopFade: false, hasBottomFade: false });
    const handleScroll = () => {
        const element = scrollRef.current;
        if (!element) return;
        const { scrollTop, scrollHeight, clientHeight } = element;
        setScrollState({
            hasTopFade: scrollTop > 0,
            hasBottomFade: scrollTop + clientHeight < scrollHeight - 1,
        });
    };
    useEffect(() => {
        handleScroll();
    }, [groups]);

    return (
        <div className={cn("app-workspace-sidebar-nav flex h-full shrink-0 flex-col", collapsed && "is-collapsed")}>
            <WorkspaceSwitcher collapsed={collapsed} onNavigate={onNavigate} onExpand={onExpand} onCollapse={onCollapse} />

            <LayoutGroup id="workspace-sidebar-nav">
            <div
                ref={scrollRef}
                onScroll={handleScroll}
                className={cn("app-workspace-sidebar-scroll-area flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-3 pb-3 pt-7", collapsed && "is-collapsed", scrollState.hasTopFade && "has-top-fade", scrollState.hasBottomFade && "has-bottom-fade")}
            >
                {groups.map((group, index) => (
                    <NavGroup key={index} group={group} activeId={activeId} onNavigate={onNavigate} onOpenSearch={onOpenSearch} collapsed={collapsed} />
                ))}
            </div>
            </LayoutGroup>

            <div className="app-workspace-sidebar-footer shrink-0 px-3 py-3">
                {footer.length ? (
                    <div className="flex flex-col gap-0.5">
                        {footer.map((item) => (
                            <NavItem key={item.id} item={item} activeId={activeId} onSelect={onNavigate} onOpenSearch={onOpenSearch} collapsed={collapsed} />
                        ))}
                    </div>
                ) : null}
                <div className={cn("app-workspace-sidebar-utility-row", collapsed && "is-collapsed")}>
                    <WorkspaceSidebarUpdate collapsed={collapsed} />
                    <AnimatedThemeToggler theme={theme} onThemeChange={setTheme} aria-label={theme === "dark" ? "切换到浅色模式" : "切换到深色模式"} title={theme === "dark" ? "切换到浅色模式" : "切换到深色模式"} className="app-workspace-theme-action">
                        {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
                    </AnimatedThemeToggler>
                </div>
            </div>
        </div>
    );
}

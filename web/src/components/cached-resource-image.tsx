import { useEffect, useRef, useState, type ImgHTMLAttributes, type ReactNode } from "react";

import { resourceIdFromStorageKey } from "@/services/api/resources";
import { cacheResourceObjectUrl } from "@/services/resource-blob-cache";
import { resolveImageUrl } from "@/services/image-storage";

type CachedResourceImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> & {
    storageKey?: string;
    src?: string;
    fallback?: ReactNode;
    loadingFallback?: ReactNode;
    eager?: boolean;
};

/**
 * 资源图片优先读取按用户隔离的本地 Blob 缓存，避免刷新后再次从对象存储下载。
 * 任意本地图片 storageKey 都会自动从 LocalForage 恢复有效的 Object URL。
 */
export function CachedResourceImage({ storageKey, src = "", fallback = null, loadingFallback = fallback, eager = false, onError, ...props }: CachedResourceImageProps) {
    const remoteResource = Boolean(resourceIdFromStorageKey(storageKey));
    const localImageResource = Boolean(storageKey && !remoteResource);
    const storageBackedImage = remoteResource || localImageResource;
    const targetRef = useRef<HTMLSpanElement>(null);
    const [nearViewport, setNearViewport] = useState(eager || !remoteResource);
    const [cachedSrc, setCachedSrc] = useState(storageBackedImage ? "" : src);
    const [cacheFailed, setCacheFailed] = useState(false);

    useEffect(() => {
        if (!remoteResource || eager) {
            setNearViewport(true);
            return;
        }
        const image = targetRef.current;
        if (!image || typeof IntersectionObserver === "undefined") {
            setNearViewport(true);
            return;
        }
        const observer = new IntersectionObserver(
            (entries) => {
                if (entries.some((entry) => entry.isIntersecting)) {
                    setNearViewport(true);
                    observer.disconnect();
                }
            },
            { rootMargin: "240px" },
        );
        observer.observe(image);
        return () => observer.disconnect();
    }, [eager, remoteResource]);

    useEffect(() => {
        let cancelled = false;
        setCacheFailed(false);

        if (remoteResource && storageKey) {
            if (!nearViewport) {
                setCachedSrc("");
                return () => {
                    cancelled = true;
                };
            }
            setCachedSrc("");
            const resolve = cacheResourceObjectUrl(storageKey);
            void resolve
                .then((url) => {
                    if (!cancelled) {
                        setCachedSrc(url || src);
                        setCacheFailed(!url && !src);
                    }
                })
                .catch(() => {
                    if (!cancelled) {
                        // 缓存读取失败时仍允许原始地址加载，真正的解码失败再显示占位。
                        setCacheFailed(!src);
                        setCachedSrc(src);
                    }
                });
            return () => {
                cancelled = true;
            };
        }

        if (localImageResource && storageKey) {
            void resolveImageUrl(storageKey, src)
                .then((url) => {
                    if (cancelled) return;
                    setCachedSrc(url || src);
                    // 本地缓存键也解析不出地址时，必须显式判定失败：否则会一直停在
                    // loadingFallback（例如「正在读取首帧」）而永远不显示占位或上报错误。
                    setCacheFailed(!url && !src);
                })
                .catch(() => {
                    if (cancelled) return;
                    setCachedSrc(src);
                    setCacheFailed(!src);
                });
            return () => {
                cancelled = true;
            };
        }

        setCachedSrc(src);
        return () => {
            cancelled = true;
        };
    }, [localImageResource, nearViewport, remoteResource, src, storageKey]);

    const handleImgError = (e: React.SyntheticEvent<HTMLImageElement, Event>) => {
        if (localImageResource && storageKey && cachedSrc.startsWith("blob:")) {
            void resolveImageUrl(storageKey)
                .then((url) => {
                    if (url && url !== cachedSrc) {
                        setCachedSrc(url);
                        return;
                    }
                    setCacheFailed(true);
                    onError?.(e);
                })
                .catch(() => {
                    setCacheFailed(true);
                    onError?.(e);
                });
            return;
        }
        setCacheFailed(true);
        onError?.(e);
    };

    if (!storageBackedImage) {
        if (cacheFailed && fallback) return <>{fallback}</>;
        return <img {...props} src={cachedSrc} onError={handleImgError} />;
    }
    return (
        <span ref={targetRef} className="cached-resource-image-shell">
            {cachedSrc && !cacheFailed ? <img {...props} src={cachedSrc} onError={handleImgError} /> : cacheFailed ? fallback : loadingFallback}
        </span>
    );
}

const FONT_AWESOME_READY_TIMEOUT_MS = 10000;

let initPromise = null;
let fontAwesomeInstance = null;
let iconObserver = null;
let suppressMutationCount = 0;

function isHtmlElement(node) {
    return typeof HTMLElement !== 'undefined' && node instanceof HTMLElement;
}

function isLegacyIconElement(node) {
    if (!isHtmlElement(node) || node.tagName !== 'I') {
        return false;
    }

    return Array.from(node.classList).some((className) => className.startsWith('fa-'));
}

function findLegacyIconElements(root) {
    if (!isHtmlElement(root)) {
        return [];
    }

    const icons = [];
    if (isLegacyIconElement(root)) {
        icons.push(root);
    }

    icons.push(...root.querySelectorAll('i[class*="fa-"]'));
    return icons;
}

function resetRenderedIcon(iconElement) {
    if (!isLegacyIconElement(iconElement)) {
        return;
    }

    iconElement.removeAttribute('data-fa-i2svg');
    Array.from(iconElement.children).forEach((child) => {
        if (child instanceof SVGElement && child.hasAttribute('data-fa-i2svg')) {
            child.remove();
        }
    });
}

function withMutationSuppressed(callback) {
    suppressMutationCount += 1;

    try {
        callback();
    } finally {
        queueMicrotask(() => {
            suppressMutationCount = Math.max(0, suppressMutationCount - 1);
        });
    }
}

function waitForFontAwesome() {
    return new Promise((resolve, reject) => {
        const startedAt = Date.now();

        const check = () => {
            const fontAwesome = window.FontAwesome;
            if (fontAwesome?.dom?.i2svg) {
                resolve(fontAwesome);
                return;
            }

            if (Date.now() - startedAt >= FONT_AWESOME_READY_TIMEOUT_MS) {
                reject(new Error('Font Awesome SVG runtime did not load in time.'));
                return;
            }

            window.requestAnimationFrame(check);
        };

        check();
    });
}

function renderLegacyIcons(root = document.body) {
    if (!fontAwesomeInstance?.dom?.i2svg || !root) {
        return;
    }

    const initialRoot = root === document || root === document.documentElement
        ? document.body
        : root;
    const targetRoot = isLegacyIconElement(initialRoot) && initialRoot.parentElement
        ? initialRoot.parentElement
        : initialRoot;

    if (!targetRoot) {
        return;
    }

    withMutationSuppressed(() => {
        findLegacyIconElements(targetRoot).forEach(resetRenderedIcon);
        fontAwesomeInstance.dom.i2svg({
            node: targetRoot
        });
    });
}

function refreshLegacyIcon(iconElement) {
    if (!isLegacyIconElement(iconElement)) {
        return;
    }

    const renderRoot = iconElement.parentElement || iconElement;
    renderLegacyIcons(renderRoot);
}

function handleIconMutations(mutations) {
    if (suppressMutationCount > 0) {
        return;
    }

    const renderRoots = new Set();
    const refreshTargets = new Set();

    mutations.forEach((mutation) => {
        if (mutation.type === 'attributes' && mutation.attributeName === 'class') {
            if (isLegacyIconElement(mutation.target)) {
                refreshTargets.add(mutation.target);
            }
            return;
        }

        mutation.addedNodes.forEach((node) => {
            if (!isHtmlElement(node)) {
                return;
            }

            if (findLegacyIconElements(node).length > 0) {
                renderRoots.add(node);
            }
        });
    });

    refreshTargets.forEach(refreshLegacyIcon);
    renderRoots.forEach(renderLegacyIcons);
}

function startIconObserver() {
    if (iconObserver || !document.body) {
        return;
    }

    iconObserver = new MutationObserver(handleIconMutations);
    iconObserver.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class']
    });
}

async function initIcons() {
    if (initPromise) {
        return initPromise;
    }

    initPromise = (async () => {
        if (typeof window === 'undefined' || typeof document === 'undefined') {
            return;
        }

        fontAwesomeInstance = await waitForFontAwesome();
        renderLegacyIcons(document.body);
        startIconObserver();
        window.renderIcons = renderIcons;
    })();

    return initPromise;
}

async function renderIcons(root = document.body) {
    await initIcons();
    renderLegacyIcons(root);
}

export {
    initIcons,
    renderIcons
};

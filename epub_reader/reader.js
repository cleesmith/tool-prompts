import './view.js'
import { createTOCView } from './ui/tree.js'
import { createMenu } from './ui/menu.js'
import { Overlayer } from './overlayer.js'

console.log('=== READER.JS LOADED - POSITION TRACKING ENABLED ===');

// Global error handler to prevent reader freezing
window.addEventListener('unhandledrejection', e => {
    console.error('Unhandled promise rejection:', e.reason)
    console.log('Reader will continue operating normally')
    e.preventDefault()
});

// Handle uncaught errors from foliate-js
window.addEventListener('error', e => {
    if (e.message.includes('Cannot destructure property') || 
        e.message.includes('null') || 
        e.filename?.includes('paginator.js')) {
        console.warn('Foliate-js internal error (non-critical):', e.message)
        e.preventDefault()
        return false
    }
});

const getCSS = ({ spacing, justify, hyphenate }) => `
    @namespace epub "http://www.idpf.org/2007/ops";
    html {
        color-scheme: light dark;
    }
    /* https://github.com/whatwg/html/issues/5426 */
    @media (prefers-color-scheme: dark) {
        a:link {
            color: lightblue;
        }
    }
    p, li, blockquote, dd {
        line-height: ${spacing};
        text-align: ${justify ? 'justify' : 'start'};
        -webkit-hyphens: ${hyphenate ? 'auto' : 'manual'};
        hyphens: ${hyphenate ? 'auto' : 'manual'};
        -webkit-hyphenate-limit-before: 3;
        -webkit-hyphenate-limit-after: 2;
        -webkit-hyphenate-limit-lines: 2;
        hanging-punctuation: allow-end last;
        widows: 2;
    }
    /* prevent the above from overriding the align attribute */
    [align="left"] { text-align: left; }
    [align="right"] { text-align: right; }
    [align="center"] { text-align: center; }
    [align="justify"] { text-align: justify; }

    pre {
        white-space: pre-wrap !important;
    }
    aside[epub|type~="endnote"],
    aside[epub|type~="footnote"],
    aside[epub|type~="note"],
    aside[epub|type~="rearnote"] {
        display: none;
    }
`

const $ = document.querySelector.bind(document)

// Safe localStorage wrapper
const storage = {
    available: (() => {
        try {
            const test = 'test';
            localStorage.setItem(test, test);
            localStorage.removeItem(test);
            return true;
        } catch (e) {
            return false;
        }
    })(),
    
    get(key) {
        if (!this.available) return null;
        try {
            return JSON.parse(localStorage.getItem(key));
        } catch (e) {
            return null;
        }
    },
    
    set(key, value) {
        if (!this.available) return false;
        try {
            localStorage.setItem(key, JSON.stringify(value));
            return true;
        } catch (e) {
            return false;
        }
    }
};

const locales = 'en'
const percentFormat = new Intl.NumberFormat(locales, { style: 'percent' })
const listFormat = new Intl.ListFormat(locales, { style: 'short', type: 'conjunction' })

const formatLanguageMap = x => {
    if (!x) return ''
    if (typeof x === 'string') return x
    const keys = Object.keys(x)
    return x[keys[0]]
}

const formatOneContributor = contributor => typeof contributor === 'string'
    ? contributor : formatLanguageMap(contributor?.name)

const formatContributor = contributor => Array.isArray(contributor)
    ? listFormat.format(contributor.map(formatOneContributor))
    : formatOneContributor(contributor)

class Reader {
    #tocView
    style = {
        spacing: 1.4,
        justify: true,
        hyphenate: true,
    }
    annotations = new Map()
    annotationsByValue = new Map()
    closeSideBar() {
        $('#dimming-overlay').classList.remove('show')
        $('#side-bar').classList.remove('show')
    }
    findNextChapter(currentHref) {
        if (!this.view?.book?.toc) return null
        const flatToc = this.flattenToc(this.view.book.toc)
        const currentIndex = flatToc.findIndex(item => item.href === currentHref)
        return currentIndex >= 0 && currentIndex < flatToc.length - 1 ? flatToc[currentIndex + 1] : null
    }
    flattenToc(toc, result = []) {
        for (const item of toc) {
            if (item.href) result.push(item)
            if (item.subitems) this.flattenToc(item.subitems, result)
        }
        return result
    }
    updateNextChapterButton(fraction, tocItem) {
        const nextChapterBtn = $('#next-chapter-btn')
        
        // Always show button if there's a next chapter available
        if (tocItem?.href) {
            const nextChapter = this.findNextChapter(tocItem.href)
            if (nextChapter) {
                nextChapterBtn.style.display = 'block'
                nextChapterBtn.title = `Next: ${nextChapter.label}`
            } else {
                nextChapterBtn.style.display = 'none'
            }
        } else {
            nextChapterBtn.style.display = 'none'
        }
    }
    constructor() {
        $('#side-bar-button').addEventListener('click', () => {
            $('#dimming-overlay').classList.add('show')
            $('#side-bar').classList.add('show')
        })
        $('#dimming-overlay').addEventListener('click', () => this.closeSideBar())

        // Theme toggle removed
    }
    async open(file) {
        this.view = document.createElement('foliate-view')
        document.body.append(this.view)
        await this.view.open(file)
        this.view.addEventListener('load', this.#onLoad.bind(this))
        this.view.addEventListener('relocate', this.#onRelocate.bind(this))

        const { book } = this.view
        book.transformTarget?.addEventListener('data', ({ detail }) => {
            detail.data = Promise.resolve(detail.data).catch(e => {
                console.error(new Error(`Failed to load ${detail.name}`, { cause: e }))
                return ''
            })
        })
        this.view.renderer.setStyles?.(getCSS(this.style))
        this.view.renderer.setAttribute('flow', 'scrolled')
        
        // Restore reading position
        const bookId = book.metadata?.identifier || 'liz-epub'
        console.log('Looking for saved position with bookId:', bookId)
        const savedPosition = storage.get(`foliate-position-${bookId}`)
        console.log('Saved position found:', savedPosition)
        if (savedPosition) {
            if (savedPosition.cfi) {
                console.log('Attempting to restore to CFI:', savedPosition.cfi)
                try {
                    await this.view.goTo(savedPosition.cfi)
                    console.log('Position restored successfully via CFI')
                } catch (e) {
                    console.warn('Failed to restore position via CFI:', e)
                    this.view.renderer.next()
                }
            } else if (savedPosition.fraction) {
                console.log('Attempting to restore to fraction:', savedPosition.fraction)
                try {
                    // Add delay to ensure book is fully loaded
                    await new Promise(resolve => setTimeout(resolve, 100))
                    await this.view.goToFraction(savedPosition.fraction)
                    console.log('Position restored successfully via fraction')
                } catch (e) {
                    console.warn('Failed to restore position via fraction:', e)
                    console.log('Falling back to normal navigation')
                    this.view.renderer.next()
                }
            } else {
                console.log('No valid position data found, starting from beginning')
                this.view.renderer.next()
            }
        } else {
            console.log('No saved position found, starting from beginning')
            this.view.renderer.next()
        }

        $('#header-bar').style.visibility = 'visible'
        // Navigation buttons removed for scrolled mode

        // Progress slider removed to prevent navigation errors

        // Setup next chapter button
        const nextChapterBtn = $('#next-chapter-btn')
        nextChapterBtn.addEventListener('click', () => {
            const currentTocItem = this.currentTocItem
            if (currentTocItem) {
                const nextChapter = this.findNextChapter(currentTocItem.href)
                if (nextChapter) {
                    this.view.goTo(nextChapter.href).catch(e => console.error('Next chapter navigation failed:', e))
                }
            }
        })

        document.addEventListener('keydown', this.#handleKeydown.bind(this))

        const title = formatLanguageMap(book.metadata?.title) || 'Untitled Book'
        document.title = title
        $('#side-bar-title').innerText = title
        $('#side-bar-author').innerText = formatContributor(book.metadata?.author)
        Promise.resolve(book.getCover?.())?.then(blob =>
            blob ? $('#side-bar-cover').src = URL.createObjectURL(blob) : null)

        const toc = book.toc
        if (toc) {
            this.#tocView = createTOCView(toc, href => {
                this.view.goTo(href).catch(e => console.error(e))
                this.closeSideBar()
            })
            $('#toc-view').append(this.#tocView.element)


        }

        // load and show highlights embedded in the file by Calibre
        const bookmarks = await book.getCalibreBookmarks?.()
        if (bookmarks) {
            const { fromCalibreHighlight } = await import('./epubcfi.js')
            for (const obj of bookmarks) {
                if (obj.type === 'highlight') {
                    const value = fromCalibreHighlight(obj)
                    const color = obj.style.which
                    const note = obj.notes
                    const annotation = { value, color, note }
                    const list = this.annotations.get(obj.spine_index)
                    if (list) list.push(annotation)
                    else this.annotations.set(obj.spine_index, [annotation])
                    this.annotationsByValue.set(value, annotation)
                }
            }
            this.view.addEventListener('create-overlay', e => {
                const { index } = e.detail
                const list = this.annotations.get(index)
                if (list) for (const annotation of list)
                    this.view.addAnnotation(annotation)
            })
            this.view.addEventListener('draw-annotation', e => {
                const { draw, annotation } = e.detail
                const { color } = annotation
                draw(Overlayer.highlight, { color })
            })
            this.view.addEventListener('show-annotation', e => {
                const annotation = this.annotationsByValue.get(e.detail.value)
                if (annotation.note) alert(annotation.note)
            })
        }
    }
    #handleKeydown(event) {
        // Arrow key navigation disabled for scrolled mode
        // Use mouse/trackpad scrolling instead
    }
    #onLoad({ detail: { doc } }) {
        doc.addEventListener('keydown', this.#handleKeydown.bind(this))
    }
    #onRelocate({ detail }) {
        const { fraction, location, tocItem, pageItem, cfi } = detail
        const percent = percentFormat.format(fraction)
        const loc = pageItem
            ? `Page ${pageItem.label}`
            : `Loc ${location.current}`
        // Progress slider removed
        if (tocItem?.href) this.#tocView?.setCurrentHref?.(tocItem.href)
        
        // Track current TOC item for next chapter navigation
        this.currentTocItem = tocItem
        
        // Show/hide next chapter button based on position
        this.updateNextChapterButton(fraction, tocItem)
        
        // Save reading position
        const bookId = this.view?.book?.metadata?.identifier || 'liz-epub'
        const position = {
            cfi,
            fraction,
            location,
            timestamp: Date.now()
        }
        console.log('Saving position:', position)
        const success = storage.set(`foliate-position-${bookId}`, position)
        console.log('Position saved:', success)
    }
}

const open = async file => {
    document.body.removeChild($('#drop-target'))
    const reader = new Reader()
    globalThis.reader = reader
    await reader.open(file)
}

// Auto-load
open('Ovid_via_Vellum.epub').catch(e => {
    console.error('Failed to load .epub:', e)
    // Show error message
    const dropTarget = $('#drop-target')
    dropTarget.querySelector('h1').textContent = 'Error loading book'
    dropTarget.querySelector('p').textContent = 'Failed to load .epub'
    dropTarget.style.visibility = 'visible'
})

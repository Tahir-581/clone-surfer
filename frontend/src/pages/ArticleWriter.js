import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useEditor, EditorContent } from '@tiptap/react';
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import StarterKit from '@tiptap/starter-kit';
import { Underline } from '@tiptap/extension-underline';
import { TextAlign } from '@tiptap/extension-text-align';
import { TextStyle } from '@tiptap/extension-text-style';
import { Color } from '@tiptap/extension-color';
import { Highlight } from '@tiptap/extension-highlight';
import { Image } from '@tiptap/extension-image';
import { Link } from '@tiptap/extension-link';
import { Table } from '@tiptap/extension-table';
import { TableRow } from '@tiptap/extension-table-row';
import { TableCell } from '@tiptap/extension-table-cell';
import { TableHeader } from '@tiptap/extension-table-header';
import { Placeholder } from '@tiptap/extension-placeholder';
import {
  Bold, Italic, Underline as UnderlineIcon, Strikethrough,
  AlignLeft, AlignCenter, AlignRight, AlignJustify,
  List, ListOrdered, Undo2, Redo2,
  Code, Quote, Minus, ImageIcon, Link2, Table as TableIcon,
  RemoveFormatting, Pilcrow, Heading1, Heading2, Heading3,
  Heading4, Heading5, Heading6, ChevronDown, ChevronLeft, ChevronRight, ArrowLeft,
  Hash, Type, BarChart3, Eye, Search, Save, History, Info,
  ArrowDownToLine, ArrowUpFromLine, SlidersHorizontal, Copy, Share2, ShieldCheck
} from 'lucide-react';
import axios from 'axios';
import * as Diff from 'diff';
import { toast } from 'react-toastify';
import { config } from '../config';
import { getStoredUser, canViewHistory, canWriteArticle, canMarkArticleStatus, canPublishReview, normalizeRole } from '../utils/roles';
import '../styles/ArticleWriter.css';

/* ─── Inline Diff View (replaces editor content, HTML-aware with prev/next nav) ─── */
function InlineDiffEditorView({ patch, revisionMeta, onClose, onPrev, onNext, currentIndex, totalCount }) {
  const reconstructedHtml = React.useMemo(() => {
    try {
      if (!patch) return '<p><em>No content recorded for this revision.</em></p>';
      const diffs = JSON.parse(patch);
      // Reconstruct HTML with <del>/<ins> wrappers to preserve all heading/paragraph/link formatting
      return diffs
        .map((part) => {
          if (part.removed) return `<del class="aw-diff-removed">${part.value}</del>`;
          if (part.added) return `<ins class="aw-diff-added">${part.value}</ins>`;
          return part.value;
        })
        .join('');
    } catch (e) {
      console.error('Failed to reconstruct diff HTML', e);
      return '<p><em>Could not render this revision.</em></p>';
    }
  }, [patch]);

  const hasPrev = currentIndex < totalCount - 1; // older revision
  const hasNext = currentIndex > 0;               // newer revision

  return (
    <div className="aw-inline-diff-view">
      {/* Top bar: author meta + return button */}
      <div className="aw-inline-diff-bar">
        <div className="aw-inline-diff-meta">
          <span className="aw-inline-diff-avatar">{(revisionMeta?.author || 'U')[0].toUpperCase()}</span>
          <div>
            <strong>{revisionMeta?.author || 'Unknown'}</strong>
            <span className="aw-inline-diff-role">{revisionMeta?.role || 'Writer'}</span>
          </div>
          <span className="aw-inline-diff-time">
            {revisionMeta?.savedAt ? new Date(revisionMeta.savedAt).toLocaleString() : ''}
          </span>
          <span className="aw-inline-diff-counter">Revision {totalCount - currentIndex} of {totalCount}</span>
        </div>
        <button className="aw-inline-diff-close" onClick={onClose} title="Return to Editor">Return to Editor</button>
      </div>

      {/* Formatted article content with diff markers */}
      <div
        className="aw-inline-diff-body aw-editor-content"
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: reconstructedHtml }}
      />

      {/* Bottom prev / next navigation */}
      <div className="aw-inline-diff-nav">
        <button
          className={`aw-diff-nav-btn ${!hasPrev ? 'disabled' : ''}`}
          onClick={onPrev}
          disabled={!hasPrev}
          title="View older revision"
        >
          ← Previous Change
        </button>
        <span className="aw-diff-nav-info">
          Showing {totalCount - currentIndex} / {totalCount}
        </span>
        <button
          className={`aw-diff-nav-btn ${!hasNext ? 'disabled' : ''}`}
          onClick={onNext}
          disabled={!hasNext}
          title="View newer revision"
        >
          Next Change →
        </button>
      </div>
    </div>
  );
}

/* ─── Color Presets ─── */
const COLOR_PRESETS = [
  '#000000', '#434343', '#666666', '#999999', '#cccccc', '#ffffff',
  '#ef4444', '#f97316', '#eab308', '#22c55e', '#3b82f6', '#8b5cf6',
  '#ec4899', '#14b8a6', '#06b6d4', '#6366f1', '#a855f7', '#f43f5e',
];

const ARTICLE_STORAGE_KEY = 'surfox.articleWriter.items';
const CONTENT_STRUCTURE_DEFAULTS = { words: 1200, headings: 18, paragraphs: 16, images: 20 };

const keywordHighlightKey = new PluginKey('keywordHoverHighlight');

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeKeyword(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function countKeywordOccurrences(text, keyword) {
  const kw = normalizeKeyword(keyword);
  if (!kw) return 0;
  const escaped = escapeRegExp(kw).replace(/\\ /g, '\\s+');
  const regex = new RegExp(`(^|[^\\p{L}\\p{N}_])(${escaped})(?=$|[^\\p{L}\\p{N}_])`, 'giu');
  return [...String(text || '').matchAll(regex)].length;
}

function calculateArticleScore(editor, keywords, competitorResults, contentStructure) {
  if (!editor) return 0;

  const text = editor.getText();
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const json = editor.getJSON();
  let headings = 0;
  let paragraphs = 0;
  let images = 0;
  const documentHeadings = [];

  const countNodes = (content = []) => {
    content.forEach((node) => {
      if (node.type === 'heading') {
        headings += 1;
        documentHeadings.push((node.content || []).map((child) => child.text || '').join(''));
      }
      if (node.type === 'paragraph') paragraphs += 1;
      if (node.type === 'image') images += 1;
      if (node.content) countNodes(node.content);
    });
  };

  countNodes(json.content || []);

  const avgWords = contentStructure?.words || 1200;
  const avgHeadings = contentStructure?.headings || 18;
  const avgParagraphs = contentStructure?.paragraphs || 16;
  const avgImages = contentStructure?.images || 20;

  const uniqueKeywords = [...new Set((keywords || []).map(normalizeKeyword).filter(Boolean))];
  const usedKeywords = uniqueKeywords.filter((keyword) => countKeywordOccurrences(text, keyword) > 0).length;
  const wRatio = Math.min(1, words / Math.max(avgWords, 1));
  const hRatio = Math.min(1, headings / Math.max(avgHeadings, 1));
  const pRatio = Math.min(1, paragraphs / Math.max(avgParagraphs, 1));
  const iRatio = Math.min(1, images / Math.max(avgImages, 1));
  const structureScore = (wRatio * 0.4 + hRatio * 0.2 + pRatio * 0.2 + iRatio * 0.2) * 25;
  const termsScore = uniqueKeywords.length > 0 ? (usedKeywords / uniqueKeywords.length) * 45 : 0;
  const headingsWithKeywords = documentHeadings.filter((heading) =>
    uniqueKeywords.some((keyword) => heading.toLowerCase().includes(keyword.toLowerCase()))
  ).length;
  const headingsScore = Math.min(1, headingsWithKeywords / Math.max(headings, 1)) * 15;
  const mediaScore = iRatio * 15;

  return Math.min(100, Math.round(structureScore + termsScore + headingsScore + mediaScore));
}

function extractInternalLinks(editor) {
  if (!editor) return [];
  const links = new Map();

  editor.state.doc.descendants((node) => {
    const linkMark = node.marks.find(m => m.type.name === 'link');
    if (linkMark && node.isText) {
      const text = node.text?.trim();
      const href = linkMark.attrs.href;

      if (text && href) {
        const key = `${text}|${href}`;
        if (!links.has(key)) {
          links.set(key, { text, href });
        }
      }
    }
  });

  return Array.from(links.values());
}

function buildKeywordDecorations(doc, payload) {
  const { hovered = '', persistent = [] } = payload || {};
  const decorations = [];

  // Persistent keyword highlights
  if (persistent.length > 0) {
    // Only highlight keywords that have alphanumeric characters to avoid regex errors
    const validPersistent = persistent.filter(k => k.trim().length > 0);
    if (validPersistent.length > 0) {
      // Build a regex that matches any of the persistent keywords
      const escapedTerms = validPersistent.map(k => escapeRegExp(normalizeKeyword(k)).replace(/\\ /g, '\\s+'));
      const regexStr = `(^|[^\\p{L}\\p{N}_])(${escapedTerms.join('|')})(?=$|[^\\p{L}\\p{N}_])`;
      try {
        const regex = new RegExp(regexStr, 'giu');
        doc.descendants((node, pos) => {
          if (!node.isText || !node.text) return;
          for (const match of node.text.matchAll(regex)) {
            const prefixLength = match[1]?.length || 0;
            const matchText = match[2] || '';
            const from = pos + match.index + prefixLength;
            const to = from + matchText.length;
            decorations.push(Decoration.inline(from, to, { class: 'aw-keyword-persistent-highlight' }));
          }
        });
      } catch (e) {
        // Fallback or ignore if regex fails
      }
    }
  }

  // Hovered keyword highlight
  const kw = normalizeKeyword(hovered);
  if (kw) {
    const escaped = escapeRegExp(kw).replace(/\\ /g, '\\s+');
    try {
      const regex = new RegExp(`(^|[^\\p{L}\\p{N}_])(${escaped})(?=$|[^\\p{L}\\p{N}_])`, 'giu');
      doc.descendants((node, pos) => {
        if (!node.isText || !node.text) return;
        for (const match of node.text.matchAll(regex)) {
          const prefixLength = match[1]?.length || 0;
          const matchText = match[2] || '';
          const from = pos + match.index + prefixLength;
          const to = from + matchText.length;
          decorations.push(Decoration.inline(from, to, { class: 'aw-keyword-hover-highlight' }));
        }
      });
    } catch (e) { }
  }

  return DecorationSet.create(doc, decorations);
}

const KeywordHoverHighlight = Extension.create({
  name: 'keywordHoverHighlight',

  addCommands() {
    return {
      setKeywordHover:
        (payload) =>
          ({ tr, dispatch }) => {
            if (dispatch) tr.setMeta(keywordHighlightKey, payload);
            return true;
          },
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: keywordHighlightKey,
        state: {
          init: (_, { doc }) => ({
            payload: { hovered: '', persistent: [] },
            decorations: DecorationSet.empty,
          }),
          apply: (tr, previous) => {
            const nextPayload = tr.getMeta(keywordHighlightKey);
            const payload = nextPayload !== undefined ? nextPayload : previous.payload;
            if (nextPayload !== undefined || tr.docChanged) {
              return {
                payload,
                decorations: buildKeywordDecorations(tr.doc, payload),
              };
            }
            return previous;
          },
        },
        props: {
          decorations(state) {
            return keywordHighlightKey.getState(state).decorations;
          },
        },
      }),
    ];
  },
});

function readStoredArticles() {
  try {
    const parsed = JSON.parse(localStorage.getItem(ARTICLE_STORAGE_KEY));
    if (Array.isArray(parsed)) return parsed;
  } catch (_) { }
  return [];
}

function writeStoredArticles(items) {
  localStorage.setItem(ARTICLE_STORAGE_KEY, JSON.stringify(items));
}

/* ─── Toolbar Button ─── */
function TBtn({ onClick, active, title, children, disabled }) {
  return (
    <button
      type="button"
      className={`aw-tb-btn${active ? ' active' : ''}${disabled ? ' disabled' : ''}`}
      onClick={onClick}
      title={title}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

/* ─── Toolbar ─── */
function Toolbar({ editor, onAddLink, onAddImage }) {
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [showHeadingMenu, setShowHeadingMenu] = useState(false);

  if (!editor) return null;

  const getCurrentBlock = () => {
    if (editor.isActive('heading', { level: 1 })) return 'H1';
    if (editor.isActive('heading', { level: 2 })) return 'H2';
    if (editor.isActive('heading', { level: 3 })) return 'H3';
    if (editor.isActive('heading', { level: 4 })) return 'H4';
    if (editor.isActive('heading', { level: 5 })) return 'H5';
    if (editor.isActive('heading', { level: 6 })) return 'H6';
    return 'P';
  };

  const setHeading = (level) => {
    if (level === 0) {
      editor.chain().focus().setParagraph().run();
    } else {
      editor.chain().focus().toggleHeading({ level }).run();
    }
    setShowHeadingMenu(false);
  };

  const addImage = () => {
    onAddImage();
  };

  const onImageUpload = (e) => {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        if (event.target.result) editor.chain().focus().setImage({ src: event.target.result }).run();
      };
      reader.readAsDataURL(file);
    }
  };

  const addLink = () => {
    onAddLink();
  };

  const insertTable = () => {
    editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
  };

  return (
    <div className="aw-toolbar">
      {/* Block type selector */}
      <div className="aw-tb-group">
        <div className="aw-block-selector">
          <button
            className="aw-block-trigger"
            onClick={() => setShowHeadingMenu(!showHeadingMenu)}
          >
            <Type size={14} />
            <span>{getCurrentBlock()}</span>
            <ChevronDown size={12} />
          </button>
          {showHeadingMenu && (
            <div className="aw-block-menu">
              <button onClick={() => setHeading(0)} className={getCurrentBlock() === 'P' ? 'active' : ''}>
                <Pilcrow size={14} /> Paragraph
              </button>
              <button onClick={() => setHeading(1)} className={getCurrentBlock() === 'H1' ? 'active' : ''}>
                <Heading1 size={14} /> Heading 1
              </button>
              <button onClick={() => setHeading(2)} className={getCurrentBlock() === 'H2' ? 'active' : ''}>
                <Heading2 size={14} /> Heading 2
              </button>
              <button onClick={() => setHeading(3)} className={getCurrentBlock() === 'H3' ? 'active' : ''}>
                <Heading3 size={14} /> Heading 3
              </button>
              <button onClick={() => setHeading(4)} className={getCurrentBlock() === 'H4' ? 'active' : ''}>
                <Heading4 size={14} /> Heading 4
              </button>
              <button onClick={() => setHeading(5)} className={getCurrentBlock() === 'H5' ? 'active' : ''}>
                <Heading5 size={14} /> Heading 5
              </button>
              <button onClick={() => setHeading(6)} className={getCurrentBlock() === 'H6' ? 'active' : ''}>
                <Heading6 size={14} /> Heading 6
              </button>
            </div>
          )}
        </div>
      </div>

      <span className="aw-tb-divider" />

      {/* Inline formatting */}
      <div className="aw-tb-group">
        <TBtn onClick={() => editor.chain().focus().toggleBold().run()} active={editor.isActive('bold')} title="Bold">
          <Bold size={16} />
        </TBtn>
        <TBtn onClick={() => editor.chain().focus().toggleItalic().run()} active={editor.isActive('italic')} title="Italic">
          <Italic size={16} />
        </TBtn>
        <TBtn onClick={() => editor.chain().focus().toggleUnderline().run()} active={editor.isActive('underline')} title="Underline">
          <UnderlineIcon size={16} />
        </TBtn>
        <TBtn onClick={() => editor.chain().focus().toggleStrike().run()} active={editor.isActive('strike')} title="Strikethrough">
          <Strikethrough size={16} />
        </TBtn>
      </div>

      <span className="aw-tb-divider" />

      {/* Alignment */}
      <div className="aw-tb-group">
        <TBtn onClick={() => editor.chain().focus().setTextAlign('left').run()} active={editor.isActive({ textAlign: 'left' })} title="Left">
          <AlignLeft size={16} />
        </TBtn>
        <TBtn onClick={() => editor.chain().focus().setTextAlign('center').run()} active={editor.isActive({ textAlign: 'center' })} title="Center">
          <AlignCenter size={16} />
        </TBtn>
        <TBtn onClick={() => editor.chain().focus().setTextAlign('right').run()} active={editor.isActive({ textAlign: 'right' })} title="Right">
          <AlignRight size={16} />
        </TBtn>
        <TBtn onClick={() => editor.chain().focus().setTextAlign('justify').run()} active={editor.isActive({ textAlign: 'justify' })} title="Justify">
          <AlignJustify size={16} />
        </TBtn>
      </div>

      <span className="aw-tb-divider" />

      {/* Lists */}
      <div className="aw-tb-group">
        <TBtn onClick={() => editor.chain().focus().toggleBulletList().run()} active={editor.isActive('bulletList')} title="Bullet List">
          <List size={16} />
        </TBtn>
        <TBtn onClick={() => editor.chain().focus().toggleOrderedList().run()} active={editor.isActive('orderedList')} title="Ordered List">
          <ListOrdered size={16} />
        </TBtn>
      </div>

      <span className="aw-tb-divider" />

      {/* Color */}
      <div className="aw-tb-group">
        <div className="aw-color-wrap">
          <TBtn onClick={() => setShowColorPicker(!showColorPicker)} title="Text Color">
            <span className="aw-color-icon" style={{ borderBottomColor: editor.getAttributes('textStyle').color || 'var(--text-primary)' }}>A</span>
          </TBtn>
          {showColorPicker && (
            <div className="aw-color-picker">
              {COLOR_PRESETS.map(c => (
                <button
                  key={c}
                  className="aw-color-swatch"
                  style={{ background: c }}
                  onClick={() => { editor.chain().focus().setColor(c).run(); setShowColorPicker(false); }}
                />
              ))}
              <button className="aw-color-reset" onClick={() => { editor.chain().focus().unsetColor().run(); setShowColorPicker(false); }}>
                Reset
              </button>
            </div>
          )}
        </div>
      </div>

      <span className="aw-tb-divider" />

      {/* Insert */}
      <div className="aw-tb-group">
        <TBtn onClick={addImage} title="Insert Image">
          <ImageIcon size={16} />
        </TBtn>
        <TBtn onClick={insertTable} title="Insert Table">
          <TableIcon size={16} />
        </TBtn>
        <TBtn onClick={addLink} title="Insert Link">
          <Link2 size={16} />
        </TBtn>
      </div>

      <span className="aw-tb-divider" />

      {/* Block */}
      <div className="aw-tb-group">
        <TBtn onClick={() => editor.chain().focus().toggleCodeBlock().run()} active={editor.isActive('codeBlock')} title="Code Block">
          <Code size={16} />
        </TBtn>
        <TBtn onClick={() => editor.chain().focus().toggleBlockquote().run()} active={editor.isActive('blockquote')} title="Blockquote">
          <Quote size={16} />
        </TBtn>
        <TBtn onClick={() => editor.chain().focus().setHorizontalRule().run()} title="Horizontal Rule">
          <Minus size={16} />
        </TBtn>
        <TBtn onClick={() => editor.chain().focus().setHardBreak().run()} title="Hard Break">
          ⏎
        </TBtn>
      </div>

      <span className="aw-tb-divider" />

      {/* Undo/Redo + Clear */}
      <div className="aw-tb-group">
        <TBtn onClick={() => editor.chain().focus().undo().run()} disabled={!editor.can().undo()} title="Undo">
          <Undo2 size={16} />
        </TBtn>
        <TBtn onClick={() => editor.chain().focus().redo().run()} disabled={!editor.can().redo()} title="Redo">
          <Redo2 size={16} />
        </TBtn>
        <TBtn onClick={() => editor.chain().focus().clearNodes().unsetAllMarks().run()} title="Clear Formatting">
          <RemoveFormatting size={16} />
        </TBtn>
      </div>
    </div>
  );
}

/* ─── Content Score Sidebar (Right) ─── */
function ContentSidebar({ editor, title, keywords, setKeywords, sourceKeyword, results, selectedUrls, keywordGroups, hoveredKeyword, setHoveredKeyword, competitorResults, sidebarOpen, onToggle, userRole, setArticleStatusExt, articleKey, sessionId, contentStructure }) {
  const navigate = useNavigate();
  const handleOpenResults = () => {
    const params = new URLSearchParams();
    if (sourceKeyword || title) params.set('keyword', sourceKeyword || title);
    if (sessionId) params.set('sessionId', sessionId);
    if (articleKey) params.set('articleKey', articleKey);
    params.set('from', 'article-writer');

    navigate(`/results?${params.toString()}`, {
      state: {
        results: results,
        selectedUrls: selectedUrls,
        keyword: sourceKeyword || title,
        sessionId: sessionId,
        articleKey: articleKey,
        keywordOutput: keywordGroups,
      }
    });
  };
  const [activeEntityTab, setActiveEntityTab] = useState('All');
  const [openSection, setOpenSection] = useState('entities');
  const [entitySearch, setEntitySearch] = useState('');
  const [showAdjustMenu, setShowAdjustMenu] = useState(false);
  const [entitiesListHeight, setEntitiesListHeight] = useState(260);
  const [sidebarWidth, setSidebarWidth] = useState(340);
  const entityResizeRef = useRef({ startX: 0, startY: 0, startHeight: 260, startWidth: 340 });
  const [settings, setSettings] = useState({
    showCount: false,
    highlightTerms: false,
    hideUnused: false,
  });

  const [metaTags, setMetaTags] = useState({
    title: '',
    description: ''
  });

  // Helper for 1k, 1.2k formatting
  const formatCount = (num) => {
    if (num >= 1000) {
      return (num / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    }
    return num;
  };

  const handleEntitiesResizeStart = useCallback((event) => {
    event.preventDefault();
    const startY = event.clientY ?? event.touches?.[0]?.clientY ?? 0;
    const startX = event.clientX ?? event.touches?.[0]?.clientX ?? 0;
    entityResizeRef.current = {
      startX,
      startY,
      startHeight: entitiesListHeight,
      startWidth: sidebarWidth,
    };

    const handleMove = (moveEvent) => {
      if (moveEvent.cancelable) moveEvent.preventDefault();
      const currentY = moveEvent.clientY ?? moveEvent.touches?.[0]?.clientY ?? startY;
      const currentX = moveEvent.clientX ?? moveEvent.touches?.[0]?.clientX ?? startX;
      const deltaY = currentY - entityResizeRef.current.startY;
      const deltaX = entityResizeRef.current.startX - currentX;
      const maxHeight = Math.max(320, Math.floor(window.innerHeight * 0.72));
      const maxWidth = Math.min(620, Math.max(340, Math.floor(window.innerWidth * 0.45)));
      const nextHeight = Math.max(190, Math.min(maxHeight, entityResizeRef.current.startHeight + deltaY));
      const nextWidth = Math.max(300, Math.min(maxWidth, entityResizeRef.current.startWidth + deltaX));
      setEntitiesListHeight(nextHeight);
      setSidebarWidth(nextWidth);
    };

    const handleEnd = () => {
      document.body.classList.remove('aw-resizing-entities');
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleEnd);
      window.removeEventListener('touchmove', handleMove);
      window.removeEventListener('touchend', handleEnd);
    };

    document.body.classList.add('aw-resizing-entities');
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleEnd);
    window.addEventListener('touchmove', handleMove, { passive: false });
    window.addEventListener('touchend', handleEnd);
  }, [entitiesListHeight, sidebarWidth]);

  const [articleText, setArticleText] = useState(() => editor?.getText() || '');
  const [internalLinks, setInternalLinks] = useState(() => extractInternalLinks(editor));
  const articleTextTimerRef = useRef(null);

  const [stats, setStats] = useState({ words: 0, headings: 0, paragraphs: 0, images: 0, chars: 0 });

  // Readability Calculation (Simplified Flesch Reading Ease)
  const readability = useMemo(() => {
    if (!articleText) return { score: 0, level: 'N/A' };
    const words = articleText.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return { score: 0, level: 'N/A' };
    const sentences = articleText.split(/[.!?]+/).filter(s => s.trim().length > 0).length || 1;
    const syllableCount = articleText.split(/[aeiouy]+/i).length; // Rough syllable estimate
    const score = Math.round(206.835 - 1.015 * (words.length / sentences) - 84.6 * (syllableCount / words.length));

    let level = "College level education";
    if (score > 90) level = "5th grade level";
    else if (score > 80) level = "6th grade level";
    else if (score > 70) level = "7th grade level";
    else if (score > 60) level = "8th & 9th grade level";
    else if (score > 50) level = "10th to 12th grade level";
    else if (score > 30) level = "College level education";
    else level = "College graduate level";

    return { score: Math.max(0, Math.min(100, score)), level };
  }, [articleText]);

  const navigateToKeyword = useCallback((keyword) => {
    try {
      if (!editor) return;
      const { doc } = editor.state;
      let foundPos = -1;
      const kw = normalizeKeyword(keyword);
      if (!kw) return;

      const escaped = escapeRegExp(kw).replace(/\\ /g, '\\s+');
      const regex = new RegExp(`(^|[^\\p{L}\\p{N}_])(${escaped})(?=$|[^\\p{L}\\p{N}_])`, 'giu');

      doc.descendants((node, pos) => {
        if (foundPos !== -1) return false;
        if (node.isText && node.text) {
          const match = regex.exec(node.text);
          if (match) {
            const prefixLength = match[1]?.length || 0;
            foundPos = pos + match.index + prefixLength;
          }
        }
        return true;
      });

      if (foundPos !== -1) {
        editor.chain().focus().setTextSelection(foundPos).scrollIntoView().run();
      }
    } catch (error) {
      console.error('Failed to navigate to keyword:', error);
    }
  }, [editor]);



  useEffect(() => {
    if (!editor) return;
    const update = () => {
      const text = editor.getText();
      // Stats update immediately for feedback
      const words = text.trim() ? text.trim().split(/\s+/).length : 0;
      const json = editor.getJSON();
      let headings = 0, paragraphs = 0, images = 0;
      if (json.content) {
        const countNodes = (content) => {
          content.forEach(node => {
            if (node.type === 'heading') headings++;
            if (node.type === 'paragraph') paragraphs++;
            if (node.type === 'image') images++;
            if (node.content) countNodes(node.content);
          });
        };
        countNodes(json.content);
      }
      setStats({ words, headings, paragraphs, images, chars: text.length });
      setInternalLinks(extractInternalLinks(editor));

      // Debounce the text update for keyword counting to keep the UI smooth
      if (articleTextTimerRef.current) {
        clearTimeout(articleTextTimerRef.current);
      }
      articleTextTimerRef.current = setTimeout(() => {
        setArticleText(text);
      }, 500);
    };
    editor.on('update', update);
    update();
    return () => {
      editor.off('update', update);
      if (articleTextTimerRef.current) {
        clearTimeout(articleTextTimerRef.current);
      }
    };
  }, [editor]);

  const keywordUsage = useMemo(() => {
    const unique = [...new Set(keywords.map(normalizeKeyword).filter(Boolean))];
    return unique.map((keyword) => ({
      keyword,
      count: countKeywordOccurrences(articleText, keyword),
    }));
  }, [articleText, keywords]);

  const persistentKeywords = useMemo(() => {
    if (!settings.highlightTerms) return [];
    return keywordUsage.filter(k => k.count > 0).map(k => k.keyword);
  }, [keywordUsage, settings.highlightTerms]);

  useEffect(() => {
    try {
      if (!editor) return;
      editor.commands.setKeywordHover({
        hovered: hoveredKeyword || '',
        persistent: persistentKeywords
      });
    } catch (error) {
      console.error('Failed to update keyword highlights:', error);
    }
  }, [editor, hoveredKeyword, persistentKeywords]);

  const documentHeadings = useMemo(() => {
    if (!editor) return [];
    const hdgs = [];
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'heading') {
        hdgs.push(node.textContent);
      }
    });
    return hdgs;
  }, [articleText, editor]);

  const filteredEntities = useMemo(() => {
    let list = keywordUsage;
    if (settings.hideUnused) {
      list = list.filter(item => item.count > 0);
    }
    if (entitySearch) {
      list = list.filter(item => item.keyword.toLowerCase().includes(entitySearch.toLowerCase()));
    }
    return list;
  }, [keywordUsage, entitySearch, settings.hideUnused]);

  // Reusable clipboard copy with fallback for insecure contexts
  const copyToClipboard = async (text, successMessage = 'Copied') => {
    let success = false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        success = true;
      }
    } catch (e) {
      success = false;
    }

    if (!success) {
      const textArea = document.createElement("textarea");
      textArea.value = text;
      textArea.style.position = "fixed";
      textArea.style.left = "-9999px";
      textArea.style.top = "-9999px";
      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();
      try {
        success = document.execCommand('copy');
      } catch (err) {
        success = false;
      }
      document.body.removeChild(textArea);
    }
    return success;
  };

  // Convert HTML to clean Markdown with symbols (###, **, etc.)
  const convertToMarkdown = (html) => {
    if (!html) return '';
    let md = html;

    // Convert Headings
    md = md.replace(/<h1>(.*?)<\/h1>/gi, '# $1\n\n');
    md = md.replace(/<h2>(.*?)<\/h2>/gi, '## $1\n\n');
    md = md.replace(/<h3>(.*?)<\/h3>/gi, '### $1\n\n');
    md = md.replace(/<h4>(.*?)<\/h4>/gi, '#### $1\n\n');

    // Convert Bold & Italic
    md = md.replace(/<strong>(.*?)<\/strong>/gi, '**$1**');
    md = md.replace(/<b>(.*?)<\/b>/gi, '**$1**');
    md = md.replace(/<em>(.*?)<\/em>/gi, '*$1*');
    md = md.replace(/<i>(.*?)<\/i>/gi, '*$1*');

    // Convert Lists
    md = md.replace(/<li>(.*?)<\/li>/gi, '- $1\n');
    md = md.replace(/<ul>/gi, '');
    md = md.replace(/<\/ul>/gi, '\n');
    md = md.replace(/<ol>/gi, '');
    md = md.replace(/<\/ol>/gi, '\n');

    // Convert Links
    md = md.replace(/<a [^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, '[$2]($1)');

    // Convert Paragraphs & Line Breaks
    md = md.replace(/<p>(.*?)<\/p>/gi, '$1\n\n');
    md = md.replace(/<br\s*\/?>/gi, '\n');

    // Remove remaining HTML tags
    md = md.replace(/<[^>]*>/g, '');

    // Decode common entities
    const decoder = document.createElement('textarea');
    decoder.innerHTML = md;
    return decoder.value.trim();
  };

  // Safe file downloader with cleanup
  const downloadFile = (content, filename, type) => {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');

    link.href = url;
    link.download = filename;
    link.style.display = 'none';

    document.body.appendChild(link);
    link.click();

    // Cleanup to prevent memory leaks and "insecure" flags hanging around
    setTimeout(() => {
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    }, 100);
  };

  const handleCopyEntities = async () => {
    // Copy ALL entities in the current tab
    const sourceList = activeEntityTab === 'All'
      ? keywordUsage.map(k => k.keyword)
      : documentHeadings;

    if (sourceList.length === 0) return;
    const textToCopy = sourceList.join('\n');

    const success = await copyToClipboard(textToCopy);

    if (success) {
      const btn = document.querySelector('.aw-copy-entities');
      if (btn) {
        const originalContent = btn.innerHTML;
        btn.innerHTML = `<span>✓ Copied ${sourceList.length} entities</span>`;
        btn.classList.add('copied');
        setTimeout(() => {
          btn.innerHTML = originalContent;
          btn.classList.remove('copied');
        }, 2000);
      }
    }
  };

  const usedKeywords = keywordUsage.filter((item) => item.count > 0).length;
  const totalKeywords = keywordUsage.length;

  // Calculate scores for each competitor to get accurate Avg and Top
  const competitorStats = useMemo(() => {
    const avgWords = contentStructure?.words ?? 1200;
    const topWords = Math.round(avgWords * 1.15);

    const avgHeadings = contentStructure?.headings ?? 18;
    const topHeadings = Math.round(avgHeadings * 1.2);

    const avgParagraphs = contentStructure?.paragraphs ?? 16;
    const topParagraphs = Math.round(avgParagraphs * 1.2);

    const avgImages = contentStructure?.images ?? 20;
    const topImages = Math.round(avgImages * 1.2);

    const usable = (competitorResults || []).filter((result) => Number(result.word_count) > 0);
    // In a real app, these scores would come from the backend or be calculated per competitor
    // Here we simulate the proprietary weighted aggregate (0-100)
    const scores = usable.map((result) => {
      // 1. Structure (25%)
      const sScore = (
        Math.min(1, Number(result.word_count || 0) / avgWords) * 0.4 +
        0.3 + // headings placeholder
        0.3    // paragraphs placeholder
      ) * 25;

      // 2. Terms (45%)
      const tScore = Math.min(45, (Number(result.authority || 0) / 10) * 45 + 20);

      // 3. Headings (15%)
      const hScore = result.title ? 15 : 10;

      // 4. Media (15%)
      const mScore = 12; // placeholder

      return Math.min(100, Math.round(sScore + tScore + hScore + mScore));
    });

    const avgScore = scores.length ? Math.round(scores.reduce((sum, value) => sum + value, 0) / scores.length) : 49;
    const topScore = scores.length ? Math.max(...scores) : 62;

    return {
      avgScore,
      topScore,
      avgWords,
      topWords,
      avgHeadings,
      topHeadings,
      avgParagraphs,
      topParagraphs,
      avgImages,
      topImages,
    };
  }, [competitorResults, contentStructure]);

  // Proprietary weighted aggregate (0–100) for CURRENT user
  const score = useMemo(() => {
    if (!editor) return 0;

    // Pillar 1: Structure (25%) - Words, Headings, Paragraphs, Images
    const wRatio = Math.min(1, stats.words / Math.max(competitorStats.avgWords, 1));
    const hRatio = Math.min(1, stats.headings / Math.max(competitorStats.avgHeadings, 1));
    const pRatio = Math.min(1, stats.paragraphs / Math.max(competitorStats.avgParagraphs, 1));
    const iRatio = Math.min(1, stats.images / Math.max(competitorStats.avgImages, 1));
    const structureScore = (wRatio * 0.4 + hRatio * 0.2 + pRatio * 0.2 + iRatio * 0.2) * 25;

    // Pillar 2: Terms (NLP) (45%) - Presence and density of keywords
    const termsRatio = totalKeywords > 0 ? (usedKeywords / totalKeywords) : 0;
    // Boost score if density is optimal (simulated)
    const termsScore = termsRatio * 45;

    // Pillar 3: Headings (15%) - Keywords specifically in H1, H2, etc.
    const headingsWithKeywords = documentHeadings.filter(h =>
      keywords.some(k => h.toLowerCase().includes(k.toLowerCase()))
    ).length;
    const headingsScore = Math.min(1, headingsWithKeywords / Math.max(stats.headings, 1)) * 15;

    // Pillar 4: Media (15%) - Image count and alt-text
    const mediaScore = iRatio * 15;

    const total = Math.round(structureScore + termsScore + headingsScore + mediaScore);
    return Math.min(100, total);
  }, [stats, competitorStats, usedKeywords, totalKeywords, documentHeadings, keywords, editor]);

  // Semi-circle gauge math (pointer line only — fill uses pathLength=1)
  const gaugeAngle = ((100 - Math.max(0, Math.min(100, score))) / 100) * Math.PI;
  const GCX = 110, GCY = 110;
  const pInner = 64, pOuter = 100;
  const gpx1 = GCX + pInner * Math.cos(gaugeAngle);
  const gpy1 = GCY - pInner * Math.sin(gaugeAngle);
  const gpx2 = GCX + pOuter * Math.cos(gaugeAngle);
  const gpy2 = GCY - pOuter * Math.sin(gaugeAngle);
  // Dynamic color by score tier
  const gaugeColor = score >= 70 ? '#22c55e' : score >= 40 ? '#f59e0b' : '#ef4444';

  // Animated score counter — placed after `score` is defined to avoid TDZ
  const [displayScore, setDisplayScore] = useState(0);
  const animFrameRef = useRef(null);
  const prevScoreRef = useRef(0);

  useEffect(() => {
    const start = prevScoreRef.current;
    const end = score;
    if (start === end) return;
    if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    const duration = 700;
    const startTime = performance.now();
    const animate = (now) => {
      const t = Math.min((now - startTime) / duration, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplayScore(Math.round(start + (end - start) * eased));
      if (t < 1) {
        animFrameRef.current = requestAnimationFrame(animate);
      } else {
        prevScoreRef.current = end;
      }
    };
    animFrameRef.current = requestAnimationFrame(animate);
    return () => { if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current); };
  }, [score]);

  const sidebarStyle = typeof window !== 'undefined' && window.innerWidth > 900
    ? { width: `${sidebarWidth}px` }
    : undefined;

  return (
    <aside className={`aw-sidebar ${sidebarOpen ? 'open' : 'closed'}`} style={sidebarStyle}>
      <button
        className="aw-sidebar-toggle-tab"
        onClick={onToggle}
        title={sidebarOpen ? 'Close Sidebar' : 'Open Sidebar'}
      >
        {sidebarOpen ? <ChevronRight size={18} /> : <ChevronLeft size={18} />}
      </button>

      {/* ── Content Score Header ── */}
      <div className="aw-score-header">
        <div className="aw-score-title-row">
          <span className="aw-score-title">Content Score</span>
          <div className="aw-info-tip" title="Overall content quality score based on words, headings, paragraphs, and keyword usage">
            <Info size={14} />

          </div>
        </div>

        <div className="aw-gauge-wrap">
          <svg
            viewBox="0 0 220 115"
            className="aw-gauge-svg"
            aria-label={`Content score: ${score} out of 100`}
            aria-live="polite"
          >
            {/* Background track */}
            <path
              d="M 28 110 A 82 82 0 0 1 192 110"
              fill="none"
              stroke="#d1fae5"
              strokeWidth="16"
              strokeLinecap="round"
            />
            {/* Animated score fill — pathLength=1 makes dasharray = score% */}
            <path
              d="M 28 110 A 82 82 0 0 1 192 110"
              fill="none"
              stroke={gaugeColor}
              strokeWidth="16"
              strokeLinecap="round"
              pathLength="1"
              strokeDasharray={`${(score / 100).toFixed(3)} 1`}
              className="aw-gauge-fill"
            />
            {/* Pointer line at current score position */}
            <line
              x1={gpx1.toFixed(1)} y1={gpy1.toFixed(1)}
              x2={gpx2.toFixed(1)} y2={gpy2.toFixed(1)}
              stroke="#1e293b"
              strokeWidth="2.5"
              strokeLinecap="round"
              className="aw-gauge-pointer"
            />
            {/* Animated score number */}
            <text x="110" y="96" textAnchor="middle">
              <tspan
                fontSize="30"
                fontWeight="800"
                fill={gaugeColor}
                className="aw-gauge-score-num"
              >{displayScore}</tspan>
              <tspan fontSize="14" fontWeight="500" fill="#94a3b8">/ 100</tspan>
            </text>
          </svg>
        </div>

        <div className="aw-score-avg-row">
          <span className="aw-score-avg-item" title="Average competitor score">
            <span className="aw-avg-icon">⇕</span> Avg <strong>{competitorStats.avgScore}</strong>
          </span>
          <span className="aw-score-avg-divider" />
          <span className="aw-score-avg-item" title="Top competitor score">
            <span className="aw-top-icon">↑</span> Top <strong>{competitorStats.topScore}</strong>
          </span>
        </div>

        {/* Stats – one row */}
        <div className="aw-stats-row" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
          <div className="aw-stat-col" title={`Your word count vs competitor range ${formatCount(competitorStats.avgWords)}–${formatCount(competitorStats.topWords)}`}>
            <span className="aw-stat-col-label">Words</span>
            <span className="aw-stat-col-value">{formatCount(stats.words)}</span>
            <span className="aw-stat-col-range">{formatCount(competitorStats.avgWords)} – {formatCount(competitorStats.topWords)}</span>
          </div>
          <div className="aw-stat-col" title={`Your headings vs competitor range ${competitorStats.avgHeadings}–${competitorStats.topHeadings}`}>
            <span className="aw-stat-col-label">Headings</span>
            <span className="aw-stat-col-value">{stats.headings}</span>
            <span className="aw-stat-col-range">{competitorStats.avgHeadings} – {competitorStats.topHeadings}</span>
          </div>
          <div className="aw-stat-col" title={`Your paragraphs vs competitor range ${competitorStats.avgParagraphs}–${competitorStats.topParagraphs}`}>
            <span className="aw-stat-col-label">Paragraphs</span>
            <span className="aw-stat-col-value">{stats.paragraphs}</span>
            <span className="aw-stat-col-range">{competitorStats.avgParagraphs} – {competitorStats.topParagraphs}</span>
          </div>
          <div className="aw-stat-col" title={`Your images vs competitor range ${competitorStats.avgImages}–${competitorStats.topImages}`}>
            <span className="aw-stat-col-label">Images</span>
            <span className="aw-stat-col-value">{stats.images}</span>
            <span className="aw-stat-col-range">{competitorStats.avgImages} – {competitorStats.topImages}</span>
          </div>
        </div>
      </div>



      {/* #1 Research & Domains */}
      <div className="aw-sidebar-section">
        <button
          type="button"
          className={`aw-section-header ${openSection === 'research' ? 'active' : ''}`}
          onClick={() => setOpenSection(openSection === 'research' ? null : 'research')}
          aria-expanded={openSection === 'research'}
          title="Research & Domains — manage competitor selections and NLP keywords"
        >
          <div className="aw-section-header-info">
            <div className="aw-section-title-wrap">
              <span className="aw-section-number">#1</span>
              <span className="aw-section-title">Research &amp; Domains</span>
            </div>
            <div className="aw-info-tip" title="Configure domain selection and re-edit research settings">
              <Info size={13} />
            </div>
          </div>
          <ChevronDown size={16} style={{ transform: openSection === 'research' ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }} />
        </button>
        {openSection === 'research' && (
          <div className="aw-section-content" style={{ padding: '12px' }}>
            <button
              onClick={handleOpenResults}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '8px',
                background: '#f97316',
                color: 'white',
                border: 'none',
                padding: '10px',
                borderRadius: '6px',
                fontWeight: '600',
                cursor: 'pointer',
                transition: 'background 0.2s',
              }}
              onMouseOver={(e) => e.currentTarget.style.background = '#ea580c'}
              onMouseOut={(e) => e.currentTarget.style.background = '#f97316'}
            >
              <Search size={16} /> Re-edit Research Settings
            </button>
          </div>
        )}
      </div>

      {/* #2 Write & Optimize */}
      <div className="aw-sidebar-section aw-entities-section">
        <button
          type="button"
          className={`aw-section-header ${openSection === 'entities' ? 'active' : ''}`}
          onClick={() => setOpenSection(openSection === 'entities' ? null : 'entities')}
          aria-expanded={openSection === 'entities'}
          title="Write & Optimize — manage SEO entities and keyword usage"
        >
          <div className="aw-section-header-info">
            <div className="aw-section-title-wrap">
              <span className="aw-section-number">#2</span>
              <span className="aw-section-title">Write &amp; Optimize</span>
            </div>
            <div className="aw-info-tip" title="Optimize your content in real-time by adding missing SEO entities">
              <Info size={13} />
            </div>
          </div>
          <ChevronDown size={16} style={{ transform: openSection === 'entities' ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }} />
        </button>

        {openSection === 'entities' && (
          <div className="aw-section-content">
            {/* SEO sub-card */}
            <div className="aw-optimize-cards" style={{ gridTemplateColumns: '1fr' }}>
              <div className="aw-optimize-card" title="SEO keyword score: entities used vs total">
                <span className="aw-optimize-card-label">SEO</span>
                <div className="aw-optimize-card-score">
                  <svg width="18" height="18" viewBox="0 0 36 36">
                    <path d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" fill="none" stroke="#e2e8f0" strokeWidth="4" />
                    <path d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" fill="none" stroke="#f59e0b" strokeWidth="4" strokeDasharray={`${totalKeywords > 0 ? Math.round((usedKeywords / totalKeywords) * 100) : 0}, 100`} />
                  </svg>
                  <span>{usedKeywords}/{totalKeywords}</span>
                </div>
              </div>
            </div>

            <div className="aw-entities-header" style={{ position: 'relative', marginTop: '1.25rem' }}>
              <h3 title="SEO entities to include in your content">Entities</h3>
              <button className="aw-entities-adjust" onClick={() => setShowAdjustMenu(!showAdjustMenu)} title="Adjust entity display settings">
                <SlidersHorizontal size={14} /> Adjust
              </button>

              {showAdjustMenu && (
                <div className="aw-adjust-dropdown">
                  <div className="aw-adjust-toggle" onClick={() => setSettings({ ...settings, showCount: !settings.showCount })}>
                    <span>Show usage count</span>
                    <div className="aw-toggle-switch">
                      <input type="checkbox" checked={settings.showCount} readOnly />
                      <span className="aw-toggle-slider" />
                    </div>
                  </div>
                  <div className="aw-adjust-toggle" onClick={() => setSettings({ ...settings, highlightTerms: !settings.highlightTerms })}>
                    <span>Highlight used terms</span>
                    <div className="aw-toggle-switch">
                      <input type="checkbox" checked={settings.highlightTerms} readOnly />
                      <span className="aw-toggle-slider" />
                    </div>
                  </div>
                  <div className="aw-adjust-toggle" onClick={() => setSettings({ ...settings, hideUnused: !settings.hideUnused })}>
                    <span>Hide unused keywords</span>
                    <div className="aw-toggle-switch">
                      <input type="checkbox" checked={settings.hideUnused} readOnly />
                      <span className="aw-toggle-slider" />
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="aw-entities-search">
              <Search size={16} color="var(--text-muted)" />
              <input
                type="text"
                placeholder="Search"
                value={entitySearch}
                onChange={(e) => setEntitySearch(e.target.value)}
              />
            </div>

            <div className="aw-entities-tabs">
              <button
                className={`aw-entity-tab ${activeEntityTab === 'All' ? 'active' : ''}`}
                onClick={() => setActiveEntityTab('All')}
              >
                All <span className="aw-entity-tab-count">{filteredEntities.length}</span>
              </button>
              <button
                className={`aw-entity-tab ${activeEntityTab === 'Headings' ? 'active' : ''}`}
                onClick={() => setActiveEntityTab('Headings')}
              >
                Headings <span className="aw-entity-tab-count">{documentHeadings.length}</span>
              </button>
            </div>

            <div
              className="aw-entities-list aw-keyword-scroll"
              style={{ height: `${entitiesListHeight}px` }}
              title="Drag the handle below to resize the NLP list"
            >
              {activeEntityTab === 'All' && filteredEntities.map((item, i) => {
                const isUsed = item.count > 0;
                return (
                  <div
                    key={`entity-${i}`}
                    className={`aw-entity-pill ${isUsed ? 'used' : 'unused'} ${hoveredKeyword === item.keyword ? 'hovered' : ''}`}
                    onMouseEnter={() => {
                      if (window.awHoverTimer) clearTimeout(window.awHoverTimer);
                      setHoveredKeyword(item.keyword);
                    }}
                    onMouseLeave={() => {
                      window.awHoverTimer = setTimeout(() => {
                        setHoveredKeyword(null);
                      }, 100);
                    }}
                    onClick={() => navigateToKeyword(item.keyword)}
                    title={isUsed ? `Used ${item.count} times. Click to navigate.` : 'Not used yet'}
                  >
                    <div className="aw-entity-pill-main">
                      <span>{item.keyword}</span>
                    </div>
                    <div className="aw-entity-pill-stats">
                      {settings.showCount && (
                        <div className="aw-kw-usage-stack">
                          <span className="aw-kw-count-only">{item.count}</span>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
              {activeEntityTab === 'Headings' && documentHeadings.map((hdg, i) => (
                <div
                  key={`hdg-${i}`}
                  className={`aw-entity-pill used ${hoveredKeyword === hdg ? 'hovered' : ''}`}
                  onMouseEnter={() => {
                    if (window.awHoverTimer) clearTimeout(window.awHoverTimer);
                    setHoveredKeyword(hdg);
                  }}
                  onMouseLeave={() => {
                    window.awHoverTimer = setTimeout(() => {
                      setHoveredKeyword(null);
                    }, 100);
                  }}
                  onClick={() => navigateToKeyword(hdg)}
                  title="Heading. Click to navigate."
                >
                  <span>{hdg}</span>
                </div>
              ))}
            </div>
            <div
              className="aw-entities-resize-handle"
              role="separator"
              aria-orientation="horizontal"
              aria-label="Resize NLP list"
              title="Drag down to increase height, or left to increase width"
              onMouseDown={handleEntitiesResizeStart}
              onTouchStart={handleEntitiesResizeStart}
            >
              <span />
            </div>
            <div className="aw-entities-resize-hint">Drag down for length, left/right for width</div>

            <button className="aw-copy-entities" onClick={handleCopyEntities}>
              <Copy size={16} /> Copy all SEO entities
            </button>
          </div>
        )}
      </div>

      {/* #3 Internal Links */}
      <div className="aw-sidebar-section">
        <button
          type="button"
          className={`aw-section-header ${openSection === 'links' ? 'active' : ''}`}
          onClick={() => setOpenSection(openSection === 'links' ? null : 'links')}
          aria-expanded={openSection === 'links'}
          title="Internal Links — view and manage links in your content"
        >
          <div className="aw-section-header-info">
            <div className="aw-section-title-wrap">
              <span className="aw-section-number">#3</span>
              <span className="aw-section-title">Internal Links</span>
            </div>
            <div className="aw-info-tip" title="Review and manage links pointing to other pages in your site">
              <Info size={13} />
            </div>
          </div>
          <ChevronDown size={16} style={{ transform: openSection === 'links' ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }} />
        </button>
        {openSection === 'links' && (
          <div className="aw-section-content">
            <div className="aw-links-list">
              {internalLinks.length === 0 ? (
                <p className="aw-empty-text">No internal links found in content.</p>
              ) : (
                internalLinks.map((link, i) => {
                  // Ensure URL has a protocol to prevent relative link behavior
                  const absoluteUrl = link.href.match(/^https?:\/\//i)
                    ? link.href
                    : `https://${link.href}`;

                  return (
                    <div key={i} className="aw-link-item">
                      <div className="aw-link-anchor">Anchor: <strong>{link.text}</strong></div>
                      <div className="aw-link-url">
                        URL: <a
                          href={absoluteUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="aw-sidebar-link"
                        >
                          {link.href}
                        </a>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}
      </div>

      {/* #4 Pre-Publish Review */}
      <div className="aw-sidebar-section">
        <button
          type="button"
          className={`aw-section-header ${openSection === 'review' ? 'active' : ''}`}
          onClick={() => setOpenSection(openSection === 'review' ? null : 'review')}
          aria-expanded={openSection === 'review'}
          title="Pre-Publish Review — readability and content quality checks"
        >
          <div className="aw-section-header-info">
            <span className="aw-section-number">#4</span>
            <span className="aw-section-title">Pre-Publish Review</span>
            <div className="aw-info-tip" title="Final quality checks before your content goes live">
            </div>
          </div>
          <ChevronDown size={16} style={{ transform: openSection === 'review' ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }} />
        </button>
        {openSection === 'review' && (
          <div className="aw-section-content">
            <div className="aw-readability-section">
              <div className="aw-label-row">
                <span className="aw-field-label">Readability Score <Info size={14} className="aw-info-icon" /></span>
                <span className="aw-score-value">{(readability?.score / 10 || 0).toFixed(1)}</span>
              </div>
              <p className="aw-field-desc">
                Your text can be read by people with at least {readability?.level || 'N/A'}.
              </p>
            </div>

            {/* Mark status – content_editor + compliance_manager + admin */}
            {canMarkArticleStatus(userRole) && (
              <div className="aw-review-group" style={{ marginTop: '1rem' }}>
                <span className="aw-field-label">Mark Status</span>
                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '6px' }}>
                  <button
                    className="aw-review-main-btn"
                    style={{ background: '#3b82f6', color: '#fff', border: 'none', borderRadius: '6px', padding: '6px 14px', cursor: 'pointer', fontSize: '13px' }}
                    onClick={() => { if (typeof setArticleStatusExt === 'function') setArticleStatusExt('in_review'); }}
                  >
                    Mark In Review
                  </button>
                  <button
                    className="aw-review-main-btn"
                    style={{ background: '#10b981', color: '#fff', border: 'none', borderRadius: '6px', padding: '6px 14px', cursor: 'pointer', fontSize: '13px' }}
                    onClick={() => { if (typeof setArticleStatusExt === 'function') setArticleStatusExt('approved'); }}
                  >
                    Mark Approved
                  </button>
                  <button
                    className="aw-review-main-btn"
                    style={{ background: '#f59e0b', color: '#fff', border: 'none', borderRadius: '6px', padding: '6px 14px', cursor: 'pointer', fontSize: '13px' }}
                    onClick={() => { if (typeof setArticleStatusExt === 'function') setArticleStatusExt('drafting'); }}
                  >
                    Back to Drafting
                  </button>
                </div>
              </div>
            )}

            {/* Pre-publish review tools – compliance_manager, publisher, admin */}
            {canPublishReview(userRole) && (
              <>
                <div className="aw-review-group" style={{ marginTop: '1rem' }}>
                  <span className="aw-field-label">Plagiarism Check</span>
                  <button className="aw-review-main-btn">Run Plagiarism Checker</button>
                  <span className="aw-scan-status">Scan available</span>
                </div>
                <div className="aw-review-group">
                  <span className="aw-field-label">AI Readability <Info size={14} className="aw-info-icon" /></span>
                  <button className="aw-review-main-btn">Analyze Content</button>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* #5 Publish or Export */}
      <div className="aw-sidebar-section">
        <button
          type="button"
          className={`aw-section-header ${openSection === 'export' ? 'active' : ''}`}
          onClick={() => setOpenSection(openSection === 'export' ? null : 'export')}
          aria-expanded={openSection === 'export'}
          title="Publish or Export — export to WordPress, HTML or Markdown"
        >
          <div className="aw-section-header-info">
            <span className="aw-section-number">#5</span>
            <span className="aw-section-title">Publish or Export</span>
            <div className="aw-info-tip" title="Push content to your CMS or download as a file">
              <Info size={13} />
            </div>
          </div>
          <ChevronDown size={16} style={{ transform: openSection === 'export' ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }} />
        </button>
        {openSection === 'export' && (
          <div className="aw-section-content">
            <div className="aw-meta-section">
              <h4 className="aw-group-title">Meta tags</h4>
              <div className="aw-meta-field">
                <div className="aw-label-row">
                  <span className="aw-field-label">Title</span>
                  <button className="aw-copy-mini" onClick={() => copyToClipboard(metaTags.title)}><Copy size={14} /></button>
                </div>
                <textarea
                  className="aw-meta-input"
                  value={metaTags.title}
                  onChange={(e) => setMetaTags({ ...metaTags, title: e.target.value })}
                  placeholder="Enter SEO title..."
                  rows={2}
                />
                <div className="aw-meta-counter">
                  <span className={metaTags.title.length > 70 ? 'over' : ''}>{metaTags.title.length}/70</span>
                </div>
              </div>
              <div className="aw-meta-field">
                <div className="aw-label-row">
                  <span className="aw-field-label">Description</span>
                  <button className="aw-copy-mini" onClick={() => copyToClipboard(metaTags.description)}><Copy size={14} /></button>
                </div>
                <textarea
                  className="aw-meta-input"
                  value={metaTags.description}
                  onChange={(e) => setMetaTags({ ...metaTags, description: e.target.value })}
                  placeholder="Enter SEO description..."
                  rows={4}
                />
                <div className="aw-meta-counter">
                  <span className={metaTags.description.length > 156 ? 'over' : ''}>{metaTags.description.length}/156</span>
                </div>
              </div>
            </div>

            {/* Export/Publish – compliance_manager, publisher, admin */}
            {canPublishReview(userRole) && (
              <div className="aw-export-section">
                <h4 className="aw-group-title">Export</h4>
                <button className="aw-wp-btn">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12.158 12.786l-2.698 7.84c.806.236 1.657.365 2.54.365 1.047 0 2.05-.176 2.986-.502-.02-.03-.037-.064-.052-.098l-2.776-7.605zm11.594-1.511c0-.803-.147-1.358-.276-1.77-.256-.805-.496-1.148-.496-1.148-.256-.398-.829-.333-.829-.333.032.032.064.064.096.126.223.353.447.962.447 1.83 0 1.252-.738 2.375-1.474 3.787-.611 1.22-.962 2.632-.962 4.076 0 .48.032.962.128 1.413l.032.096c2.147-2.148 3.334-5.042 3.334-8.077zM12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zM1.082 11.275c0-1.83.481-3.532 1.346-5.008l5.231 14.28c-3.722-1.99-6.31-5.713-6.577-9.272zm10.74 3.659l-2.439-6.708 2.631-.032c.578 0 .802-.45.802-.45.032-.577-.545-.577-.545-.577l-3.37.032c-1.155 0-2.31.032-3.465.032 0 0-.577 0-.577.577s.577.577.577.577h.353c.642 0 .866.385.866.738l.032.193-2.375 6.483-2.118-5.938c.674-.032.899-.45.899-.45.032-.577-.546-.577-.546-.577l-3.21.032c-.064 0-.128 0-.192.032C3.104 5.341 7.21 2.324 12 2.324c1.925 0 3.721.545 5.231 1.476l-.032.064c-.93 0-1.572.834-1.572 1.765 0 .802.449 1.54 1.155 2.118.706.577 1.476 1.123 1.476 2.47 0 1.091-.577 2.148-1.187 3.53l-2.694 6.74-.225.578-2.316-6.03z" /></svg>
                  WordPress
                </button>
                <div className="aw-wp-status">
                  <span className="aw-status-dot red" />
                  <span>Not connected to any WordPress site</span>
                  <button className="aw-manage-link">Manage</button>
                </div>
              </div>
            )}

            <div className="aw-grid-section">
              <h4 className="aw-group-title">Copy</h4>
              <div className="aw-btn-grid">
                <button className="aw-grid-btn" onClick={() => {
                  const html = editor?.getHTML();
                  if (html) copyToClipboard(html);
                }}>
                  <Pilcrow size={18} />
                  <span>Content</span>
                </button>
                <button className="aw-grid-btn" onClick={() => {
                  const html = editor?.getHTML();
                  const md = convertToMarkdown(html);
                  if (md) copyToClipboard(md);
                }}>
                  <Hash size={18} />
                  <span>Markdown</span>
                </button>
              </div>
            </div>

            <div className="aw-grid-section">
              <h4 className="aw-group-title">Download</h4>
              <div className="aw-btn-grid">
                <button className="aw-grid-btn" onClick={() => {
                  const html = editor?.getHTML();
                  if (html) downloadFile(html, `${title || 'article'}.html`, 'text/html');
                }}>
                  <Code size={18} />
                  <span>HTML</span>
                </button>
                <button className="aw-grid-btn" onClick={() => {
                  const html = editor?.getHTML();
                  const md = convertToMarkdown(html);
                  if (md) downloadFile(md, `${title || 'article'}.md`, 'text/markdown');
                }}>
                  <Hash size={18} />
                  <span>Markdown</span>
                </button>
              </div>
            </div>

            <div className="aw-social-section">
              <h4 className="aw-group-title">Social media</h4>
              <p className="aw-field-desc">Create a social media post from your content</p>
              <button className="aw-social-outline-btn">Create Social Media Post</button>
            </div>
          </div>
        )}
      </div>

    </aside>
  );
}

/* ─── Main ArticleWriter ─── */
function ArticleWriter() {
  const location = useLocation();
  const navigate = useNavigate();
  const userObj = getStoredUser();
  const userRole = userObj?.role || 'content_writer';

  const passedKeywords = useMemo(() => location.state?.keywords || [], [location.state?.keywords]);
  const passedKeywordGroups = location.state?.selectedKeywords || null;
  const passedKeyword = location.state?.keyword || new URLSearchParams(location.search).get('keyword') || '';
  const competitorResults = useMemo(() => location.state?.results || [], [location.state?.results]);
  const sessionId = location.state?.sessionId || '';
  const passedArticleKey = location.state?.articleKey || new URLSearchParams(location.search).get('articleKey') || new URLSearchParams(location.search).get('key') || '';

  const [keywordGroups, setKeywordGroups] = useState(() => {
    if (passedKeywordGroups) {
      return {
        Green: passedKeywordGroups.Green || [],
        Orange: passedKeywordGroups.Orange || [],
        White: passedKeywordGroups.White || [],
      };
    }
    return {
      Green: passedKeywords.length > 0 ? passedKeywords : (passedKeyword ? [passedKeyword] : []),
      Orange: [],
      White: [],
    };
  });

  const [keywords, setKeywords] = useState(() => {
    const grouped = passedKeywordGroups
      ? [
        ...(passedKeywordGroups.Green || []),
        ...(passedKeywordGroups.Orange || []),
        ...(passedKeywordGroups.White || []),
      ]
      : [];
    if (grouped.length > 0) return [...new Set(grouped)];
    if (passedKeywords.length > 0) return passedKeywords;
    return passedKeyword ? [passedKeyword] : [];
  });

  const [hoveredKeyword, setHoveredKeyword] = useState(null);
  const [title, setTitle] = useState(passedKeyword || 'Untitled');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [revisionHistory, setRevisionHistory] = useState([]);
  const [activeDiff, setActiveDiff] = useState(null);       // { patch, author, role, savedAt }
  const [activeDiffIndex, setActiveDiffIndex] = useState(0); // index in revisionHistory
  const lastHtmlRef = useRef('');                            // last saved html for HTML-aware diffs
  const [draftVersion, setDraftVersion] = useState(0);
  const [sourceKeyword, setSourceKeyword] = useState(passedKeyword || '');
  const [results, setResults] = useState(competitorResults || []);
  const [selectedUrls, setSelectedUrls] = useState(location.state?.selectedUrls || []);
  const articleKey = passedArticleKey || sessionId || passedKeyword || title || 'untitled';
  const applyingStoredArticle = useRef(false);
  const [linkModal, setLinkModal] = useState({ open: false, url: '' });
  const [imageModal, setImageModal] = useState({ open: false, url: '', type: 'url' }); // type: 'url' or 'upload'
  const [contentScore, setContentScore] = useState(0);
  const [contentStructure, setContentStructure] = useState(() => {
    if (location.state?.contentStructure) {
      return location.state.contentStructure;
    }
    return CONTENT_STRUCTURE_DEFAULTS;
  });
  const lastSavedSnapshot = useRef('');
  const [users, setUsers] = useState([]);
  const [articleStatus, setArticleStatus] = useState('drafting');
  const [assignedTo, setAssignedTo] = useState(() => {
    const userObj = getStoredUser();
    return userObj?.id || '';
  });

  // Expose setArticleStatus for sidebar mark-status buttons (ref avoids stale closure)
  const setArticleStatusRef = useRef(null);

  const editor = useEditor({
    editable: canWriteArticle(userRole), // only admin + content_writer can edit
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3, 4, 5, 6] },
      }),
      Underline,
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      TextStyle,
      Color,
      Highlight.configure({ multicolor: true }),
      KeywordHoverHighlight,
      Image,
      Link.configure({ openOnClick: false }),
      Table.configure({ resizable: true }),
      TableRow,
      TableCell,
      TableHeader,
      Placeholder.configure({ placeholder: 'Type Here' }),
    ],
    content: '<p></p>',
    editorProps: {
      attributes: {
        class: 'aw-editor-content',
      },
    },
  });

  // The keyword hover highlighting is managed within the ContentSidebar component 
  // to avoid conflicting state updates and ensure persistent highlights are preserved.

  useEffect(() => {
    if (!editor) return;

    // Update the status-setter ref whenever saveArticle/setArticleStatus change
    setArticleStatusRef.current = (newStatus) => {
      setArticleStatus(newStatus);
      setTimeout(() => saveArticle(), 150);
    };

    const fetchUsers = async () => {
      if (userRole === 'content_writer' || userRole === 'publisher') return;
      try {
        const response = await axios.get(`${config.API_URL}/users`, {
          headers: { Authorization: `Bearer ${userObj?.token}` }
        });
        setUsers(response.data.items || []);
      } catch (e) {
        console.error("Failed to fetch users");
      }
    };
    fetchUsers();

    const loadArticle = async () => {
      const stored = readStoredArticles().find((item) => item.key === articleKey);
      if (stored) {
        applyingStoredArticle.current = true;
        setTitle(stored.title || passedKeyword || 'Untitled');
        if (stored.html) {
          editor.commands.setContent(stored.html, false);
          lastHtmlRef.current = stored.html;
        }
        if (stored.keywords) {
          const isGrouped = !Array.isArray(stored.keywords) && typeof stored.keywords === 'object';
          if (isGrouped) {
            setKeywordGroups({
              Green: stored.keywords.Green || [],
              Orange: stored.keywords.Orange || [],
              White: stored.keywords.White || [],
            });
            const kws = [
              ...(stored.keywords.Green || []),
              ...(stored.keywords.Orange || []),
              ...(stored.keywords.White || []),
            ];
            setKeywords([...new Set(kws)]);
          } else {
            setKeywords(stored.keywords);
            setKeywordGroups({
              Green: stored.keywords || [],
              Orange: [],
              White: [],
            });
          }
        }
        if (stored.content_structure && typeof stored.content_structure === 'object' && stored.content_structure.words) {
          setContentStructure(stored.content_structure);
        }
        lastSavedSnapshot.current = JSON.stringify({ title: stored.title || passedKeyword || 'Untitled', html: stored.html || '' });
        applyingStoredArticle.current = false;
      }

      let loadedKeywordGroups = null;
      if (passedKeyword) {
        try {
          const nlpResponse = await axios.get(`${config.API_URL}/nlp-keywords?source_keyword=${encodeURIComponent(passedKeyword)}`);
          const items = nlpResponse.data?.items || [];
          if (items.length > 0 && items[0].keywords_json) {
            loadedKeywordGroups = items[0].keywords_json;
            setKeywordGroups({
              Green: loadedKeywordGroups.Green || [],
              Orange: loadedKeywordGroups.Orange || [],
              White: loadedKeywordGroups.White || [],
            });
            const kws = [
              ...(loadedKeywordGroups.Green || []),
              ...(loadedKeywordGroups.Orange || []),
              ...(loadedKeywordGroups.White || []),
            ];
            setKeywords([...new Set(kws)]);
          }
        } catch (nlpErr) {
          console.warn('Could not fetch curated NLP keywords:', nlpErr);
        }
      }

      try {
        const response = await axios.get(`${config.API_URL}/articles/${encodeURIComponent(articleKey)}`);
        const article = response.data || {};
        applyingStoredArticle.current = true;
        setTitle(article.title || passedKeyword || 'Untitled');
        if (article.keyword) setSourceKeyword(article.keyword);
        if (article.results) setResults(article.results);
        if (article.selected_urls) setSelectedUrls(article.selected_urls);
        if (article.status) setArticleStatus(article.status);
        if (article.assigned_to) {
          setAssignedTo(article.assigned_to);
        } else if (userObj?.id) {
          setAssignedTo(userObj.id);
          setTimeout(() => saveArticle(article.status || 'drafting', userObj.id), 200);
        }
        if (article.html) {
          editor.commands.setContent(article.html, false);
          lastHtmlRef.current = article.html;
        }
        if (article.keywords_json) {
          const isGrouped = !Array.isArray(article.keywords_json) && typeof article.keywords_json === 'object';
          if (isGrouped) {
            setKeywordGroups({
              Green: article.keywords_json.Green || [],
              Orange: article.keywords_json.Orange || [],
              White: article.keywords_json.White || [],
            });
            const kws = [
              ...(article.keywords_json.Green || []),
              ...(article.keywords_json.Orange || []),
              ...(article.keywords_json.White || []),
            ];
            setKeywords([...new Set(kws)]);
          } else if (Array.isArray(article.keywords_json) && article.keywords_json.length > 0) {
            setKeywords(article.keywords_json);
            if (!loadedKeywordGroups) {
              setKeywordGroups({
                Green: article.keywords_json,
                Orange: [],
                White: [],
              });
            }
          }
        }
        if (article.content_structure && typeof article.content_structure === 'object' && article.content_structure.words) {
          setContentStructure(article.content_structure);
        }
        lastSavedSnapshot.current = JSON.stringify({ title: article.title || passedKeyword || 'Untitled', html: article.html || '' });
      } catch (error) {
        if (error.response?.status !== 404) {
          console.warn('Could not load stored article:', error);
        }
      } finally {
        applyingStoredArticle.current = false;
      }

      try {
        const historyResponse = await axios.get(`${config.API_URL}/articles/${encodeURIComponent(articleKey)}/history`);
        setRevisionHistory((historyResponse.data || []).map((revision) => ({
          id: revision.id,
          savedAt: revision.created_at,
          author: revision.changed_by_name || 'You',
          role: revision.changed_by_role || 'Writer',
          patch: revision.diff_patch || '',
        })));
      } catch (_) { }
    };

    loadArticle();
  }, [editor, articleKey, passedKeyword]);

  useEffect(() => {
    if (!editor) return undefined;
    const handleUpdate = () => {
      setContentScore(calculateArticleScore(editor, keywords, results, contentStructure));
      if (!applyingStoredArticle.current) {
        setDraftVersion((value) => value + 1);
      }
    };
    editor.on('update', handleUpdate);
    setContentScore(calculateArticleScore(editor, keywords, results, contentStructure));
    return () => editor.off('update', handleUpdate);
  }, [editor, keywords, results, contentStructure]);

  const saveArticle = useCallback(async (overrideStatus = null, overrideAssignedTo = null) => {
    if (!editor) return;
    const now = new Date().toISOString();
    const html = editor.getHTML();
    const text = editor.getText();
    const currentStatus = overrideStatus !== null ? overrideStatus : articleStatus;
    const currentAssignedTo = overrideAssignedTo !== null ? overrideAssignedTo : assignedTo;
    
    const snapshot = JSON.stringify({ 
      title, 
      html, 
      keywords, 
      contentScore, 
      status: currentStatus, 
      assignedTo: currentAssignedTo,
      contentStructure
    });
    
    if (overrideStatus === null && overrideAssignedTo === null && snapshot === lastSavedSnapshot.current) return;

    // Compute word-level diff patch between previous HTML and current HTML.
    // Diffing HTML (not plain text) preserves formatting tags in the stored patch,
    // so the viewer can reconstruct headings, paragraphs, links, etc. with diff markers.
    let diffPatch = null;
    const prevHtml = lastHtmlRef.current;
    if (prevHtml && prevHtml !== html) {
      try {
        const rawDiff = Diff.diffWords(prevHtml, html);
        const meaningful = rawDiff.filter(p => p.added || p.removed);
        if (meaningful.length > 0) {
          diffPatch = JSON.stringify(rawDiff);
        }
      } catch (e) {
        console.warn('Failed to compute diff', e);
      }
    }

    // Update local storage with lean record (no full history blobs)
    const items = readStoredArticles();
    const existing = items.find((item) => item.key === articleKey);
    const nextArticle = {
      key: articleKey,
      sessionId,
      title,
      keyword: passedKeyword,
      keywords: keywordGroups,
      score: contentScore,
      contentScore,
      html,
      text,
      status: currentStatus,
      assigned_to: currentAssignedTo,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      content_structure: contentStructure,
    };
    writeStoredArticles([nextArticle, ...items.filter((item) => item.key !== articleKey)]);
    lastSavedSnapshot.current = snapshot;
    lastHtmlRef.current = html;

    try {
      const userStr = localStorage.getItem('user');
      const user = userStr ? JSON.parse(userStr) : null;

      await axios.post(`${config.API_URL}/articles`, {
        article_key: articleKey,
        session_id: sessionId,
        title,
        keyword: sourceKeyword,
        keywords: keywordGroups,
        results,
        selected_urls: selectedUrls,
        content_score: contentScore,
        html,
        text,
        status: currentStatus,
        assigned_to: currentAssignedTo || null,
        user_id: user?.id,
        diff_patch: diffPatch,
        content_structure: contentStructure,
      });

      // Reload history only if a meaningful diff was saved
      if (diffPatch) {
        try {
          const historyResponse = await axios.get(`${config.API_URL}/articles/${encodeURIComponent(articleKey)}/history`);
          setRevisionHistory((historyResponse.data || []).map((revision) => ({
            id: revision.id,
            savedAt: revision.created_at,
            author: revision.changed_by_name || 'You',
            role: revision.changed_by_role || 'Writer',
            patch: revision.diff_patch || '',
          })));
        } catch (histErr) {
          console.warn('Could not reload history', histErr);
        }
      }
    } catch (error) {
      console.warn('Article saved locally; backend save failed:', error);
    }
  }, [articleKey, contentScore, editor, keywords, keywordGroups, passedKeyword, results, selectedUrls, sessionId, sourceKeyword, title, articleStatus, assignedTo, contentStructure]);

  const handlePublishByPublisher = useCallback(async () => {
    setArticleStatus('published');
    await saveArticle('published', null);
    toast.success('Article published successfully!');
  }, [saveArticle]);

  const fallbackCopyText = (text) => {
    const textArea = document.createElement('textarea');
    textArea.value = text;
    // Avoid scrolling to bottom
    textArea.style.top = '0';
    textArea.style.left = '0';
    textArea.style.position = 'fixed';
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    try {
      const successful = document.execCommand('copy');
      if (successful) {
        toast.success('Share link copied to clipboard!');
        document.body.removeChild(textArea);
        return true;
      }
    } catch (err) {
      console.warn('Fallback copy failed', err);
    }
    document.body.removeChild(textArea);
    toast.info(`Share link: ${text}`);
    return false;
  };

  const handleShare = () => {
    const shareUrl = `${window.location.origin}/article-writer?key=${encodeURIComponent(articleKey)}&keyword=${encodeURIComponent(sourceKeyword || '')}`;
    
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(shareUrl)
        .then(() => {
          toast.success('Share link copied to clipboard!');
        })
        .catch(() => {
          fallbackCopyText(shareUrl);
        });
    } else {
      fallbackCopyText(shareUrl);
    }
  };

  useEffect(() => {
    if (!editor || applyingStoredArticle.current) return undefined;
    const timer = setTimeout(() => {
      saveArticle();
    }, 1800);
    return () => clearTimeout(timer);
  }, [draftVersion, title, keywords, editor, saveArticle]);

  const handleLinkSubmit = () => {
    if (linkModal.url === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
    } else {
      editor.chain().focus().extendMarkRange('link').setLink({ href: linkModal.url }).run();
    }
    setLinkModal({ open: false, url: '' });
  };

  const handleImageSubmit = (url) => {
    if (url) editor.chain().focus().setImage({ src: url }).run();
    setImageModal({ open: false, url: '', type: 'url' });
  };

  const onImageUpload = (e) => {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        handleImageSubmit(event.target.result);
      };
      reader.readAsDataURL(file);
    }
  };

  // Custom Selection Menu Logic
  const [selectionMenu, setSelectionMenu] = useState({ visible: false, x: 0, y: 0 });

  useEffect(() => {
    if (!editor) return;

    const updateMenu = () => {
      const { selection } = editor.state;
      const { empty } = selection;

      if (empty || !editor.isFocused) {
        setSelectionMenu((prev) => ({ ...prev, visible: false }));
        return;
      }

      // Get the selection's coordinates
      const { view } = editor;
      const { from, to } = selection;
      const start = view.coordsAtPos(from);
      const end = view.coordsAtPos(to);

      // Center the menu above the selection
      const x = (start.left + end.left) / 2;
      const y = Math.min(start.top, end.top) - 10;

      setSelectionMenu({ visible: true, x, y });
    };

    editor.on('selectionUpdate', updateMenu);
    editor.on('focus', updateMenu);
    editor.on('blur', () => {
      // Small delay to allow clicking the menu buttons
      setTimeout(() => {
        if (!document.activeElement.closest('.aw-bubble-menu')) {
          setSelectionMenu((prev) => ({ ...prev, visible: false }));
        }
      }, 150);
    });

    return () => {
      editor.off('selectionUpdate', updateMenu);
      editor.off('focus', updateMenu);
    };
  }, [editor]);

  return (
    <main className="aw-page">
      {articleStatus === 'published' && (
        <div style={{
          background: 'rgba(255, 92, 0, 0.08)',
          borderBottom: '2px solid #ff5c00',
          padding: '12px 24px',
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          color: '#ff5c00',
          fontSize: '14px',
          fontWeight: '700',
          width: '100%',
        }}>
          <ShieldCheck size={20} />
          <span>This article has been published successfully and is currently live!</span>
        </div>
      )}
      {/* Top Navigation */}
      <div className="aw-topnav">
        <button className="aw-back-btn" onClick={() => navigate('/content-editor')}>
          <ArrowLeft size={18} />
          <span>Content Editor</span>
        </button>
        <div className="aw-title-wrap">
          <input
            className="aw-title-input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Untitled"
            disabled={userRole === 'outliner' || userRole === 'publisher'}
          />
          <select value={articleStatus} onChange={(e) => {
            const nextStatus = e.target.value;
            setArticleStatus(nextStatus);
            // Auto-save on status change to notify
            setTimeout(() => saveArticle(nextStatus, null), 100);
          }} disabled={userRole === 'content_writer' || userRole === 'publisher'} className="aw-status-select" style={{ marginLeft: '10px', padding: '4px 8px', borderRadius: '4px', border: '1px solid #ddd' }}>
            <option value="outline">Outline</option>
            <option value="drafting">Drafting</option>
            <option value="revision">Revision</option>
            <option value="in_review">In Review</option>
            <option value="approved">Approved</option>
            <option value="published">Published</option>
          </select>
        </div>
        <div className="aw-topnav-actions">
          {/* History – admin only */}
          {canViewHistory(userRole) && (
            <button className="aw-action-btn" type="button" onClick={() => setHistoryOpen((open) => !open)}>
              <History size={16} />
              History
            </button>
          )}
          <button className="aw-action-btn" type="button" onClick={handleShare}>
            <Share2 size={16} />
            Share
          </button>
          {userRole === 'publisher' && articleStatus === 'approved' && (
            <button 
              className="aw-action-btn" 
              type="button" 
              onClick={handlePublishByPublisher}
              style={{ background: '#ff5c00', color: '#fff', border: 'none', fontWeight: 'bold' }}
            >
              <ShieldCheck size={16} />
              Publish Now
            </button>
          )}
          {/* Save – only content_writer and admin can save edits */}
          {canWriteArticle(userRole) && (
            <button className="aw-save-btn" type="button" onClick={saveArticle}>
              <Save size={16} />
              Save
            </button>
          )}
          {/* Mark status – content_editor + compliance_manager */}
          {canMarkArticleStatus(userRole) && (
            <>
              <button
                type="button"
                className="aw-action-btn"
                style={{ background: '#3b82f6', color: '#fff', border: 'none' }}
                onClick={() => { setArticleStatus('in_review'); setTimeout(() => saveArticle(), 150); }}
              >
                Mark In Review
              </button>
              <button
                type="button"
                className="aw-action-btn"
                style={{ background: '#10b981', color: '#fff', border: 'none' }}
                onClick={() => { setArticleStatus('approved'); setTimeout(() => saveArticle(), 150); }}
              >
                Approve
              </button>
            </>
          )}
        </div>
      </div>

      {/* Toolbar */}
      <Toolbar
        editor={editor}
        onAddLink={() => setLinkModal({ open: true, url: editor.getAttributes('link').href || '' })}
        onAddImage={() => setImageModal({ open: true, url: '', type: 'url' })}
      />

      {/* Main area: Editor | SEO Sidebar */}
      <div className={`aw-workspace ${sidebarOpen ? 'sidebar-open' : ''}`}>
        <div className="aw-editor-container">
          {activeDiff ? (
            <InlineDiffEditorView
              patch={activeDiff.patch}
              revisionMeta={activeDiff}
              onClose={() => { setActiveDiff(null); setActiveDiffIndex(0); }}
              currentIndex={activeDiffIndex}
              totalCount={revisionHistory.length}
              onPrev={() => {
                const nextIdx = activeDiffIndex + 1;
                if (nextIdx < revisionHistory.length) {
                  setActiveDiffIndex(nextIdx);
                  setActiveDiff(revisionHistory[nextIdx]);
                }
              }}
              onNext={() => {
                const nextIdx = activeDiffIndex - 1;
                if (nextIdx >= 0) {
                  setActiveDiffIndex(nextIdx);
                  setActiveDiff(revisionHistory[nextIdx]);
                }
              }}
            />
          ) : (
            <>
              <EditorContent editor={editor} />

              {selectionMenu.visible && (
                <div
                  className="aw-bubble-menu"
                  style={{
                    position: 'fixed',
                    top: selectionMenu.y,
                    left: selectionMenu.x,
                    transform: 'translate(-50%, -100%)',
                    zIndex: 1000
                  }}
                >
                  <button onClick={() => editor.chain().focus().toggleBold().run()} className={editor.isActive('bold') ? 'active' : ''}>
                    <Bold size={14} />
                  </button>
                  <button onClick={() => editor.chain().focus().toggleItalic().run()} className={editor.isActive('italic') ? 'active' : ''}>
                    <Italic size={14} />
                  </button>
                  <button onClick={() => editor.chain().focus().toggleUnderline().run()} className={editor.isActive('underline') ? 'active' : ''}>
                    <UnderlineIcon size={14} />
                  </button>
                  <button onClick={() => setLinkModal({ open: true, url: editor.getAttributes('link').href || '' })} className={editor.isActive('link') ? 'active' : ''}>
                    <Link2 size={14} />
                  </button>
                </div>
              )}
            </>
          )}
        </div>
        {/* Custom Link Modal */}
        {linkModal.open && (
          <div className="aw-modal-overlay">
            <div className="aw-modal-content">
              <h3>Insert Link</h3>
              <input
                type="text"
                placeholder="https://example.com"
                value={linkModal.url}
                onChange={(e) => setLinkModal({ ...linkModal, url: e.target.value })}
                onKeyDown={(e) => e.key === 'Enter' && handleLinkSubmit()}
                autoFocus
              />
              <div className="aw-modal-actions">
                <button className="aw-modal-cancel" onClick={() => setLinkModal({ open: false, url: '' })}>Cancel</button>
                <button className="aw-modal-submit" onClick={handleLinkSubmit}>Insert</button>
              </div>
            </div>
          </div>
        )}

        {/* Custom Image Modal */}
        {imageModal.open && (
          <div className="aw-modal-overlay">
            <div className="aw-modal-content">
              <h3>Insert Image</h3>
              <div className="aw-modal-tabs">
                <button
                  className={imageModal.type === 'url' ? 'active' : ''}
                  onClick={() => setImageModal({ ...imageModal, type: 'url' })}
                >
                  URL
                </button>
                <button
                  className={imageModal.type === 'upload' ? 'active' : ''}
                  onClick={() => setImageModal({ ...imageModal, type: 'upload' })}
                >
                  Upload
                </button>
              </div>

              {imageModal.type === 'url' ? (
                <input
                  type="text"
                  placeholder="https://example.com/image.jpg"
                  value={imageModal.url}
                  onChange={(e) => setImageModal({ ...imageModal, url: e.target.value })}
                  onKeyDown={(e) => e.key === 'Enter' && handleImageSubmit(imageModal.url)}
                  autoFocus
                />
              ) : (
                <div className="aw-file-upload">
                  <input type="file" accept="image/*" onChange={onImageUpload} id="image-upload" />
                  <label htmlFor="image-upload">
                    <ImageIcon size={24} />
                    <span>Choose an image from device</span>
                  </label>
                </div>
              )}

              <div className="aw-modal-actions">
                <button className="aw-modal-cancel" onClick={() => setImageModal({ open: false, url: '', type: 'url' })}>Cancel</button>
                {imageModal.type === 'url' && (
                  <button className="aw-modal-submit" onClick={() => handleImageSubmit(imageModal.url)}>Insert</button>
                )}
              </div>
            </div>
          </div>
        )}

        {sidebarOpen && <div className="aw-sidebar-overlay visible" onClick={() => setSidebarOpen(false)} />}
        <ContentSidebar
          editor={editor}
          title={title}
          keywords={keywords}
          setKeywords={setKeywords}
          sourceKeyword={sourceKeyword}
          results={results}
          selectedUrls={selectedUrls}
          keywordGroups={keywordGroups}
          hoveredKeyword={hoveredKeyword}
          setHoveredKeyword={setHoveredKeyword}
          competitorResults={competitorResults}
          sidebarOpen={sidebarOpen}
          onToggle={() => setSidebarOpen(!sidebarOpen)}
          userRole={userRole}
          setArticleStatusExt={setArticleStatusRef.current}
          articleKey={articleKey}
          sessionId={sessionId}
          contentStructure={contentStructure}
        />

        {/* History side-list panel – admin only */}
        {historyOpen && canViewHistory(userRole) && (
          <aside className="aw-history-panel">
            <div className="aw-history-header">
              <div>
                <h3>Revision History</h3>
                <p>{revisionHistory.length} revision{revisionHistory.length !== 1 ? 's' : ''} saved</p>
              </div>
              <button type="button" onClick={() => { setHistoryOpen(false); setActiveDiff(null); }}>×</button>
            </div>
            <div className="aw-history-list">
              {revisionHistory.length === 0 ? (
                <p className="aw-history-empty">No revisions yet. Save the article to start tracking.</p>
              ) : (
                revisionHistory.map((revision) => (
                  <div
                    className={`aw-history-item ${activeDiff?.id === revision.id ? 'active' : ''}`}
                    key={revision.id}
                    onClick={() => {
                      const idx = revisionHistory.findIndex(r => r.id === revision.id);
                      if (activeDiff?.id === revision.id) {
                        setActiveDiff(null);
                        setActiveDiffIndex(0);
                      } else {
                        setActiveDiffIndex(idx);
                        setActiveDiff(revision);
                      }
                    }}
                  >
                    <div className="aw-history-item-meta">
                      <strong>{new Date(revision.savedAt).toLocaleString()}</strong>
                      <span className="aw-history-badge">{revision.role}</span>
                    </div>
                    <span className="aw-history-author">{revision.author}</span>
                    {activeDiff?.id === revision.id && (
                      <span className="aw-history-viewing">👁 Viewing in editor</span>
                    )}
                  </div>
                ))
              )}
            </div>
          </aside>
        )}
      </div>
    </main>
  );
}

export default ArticleWriter;

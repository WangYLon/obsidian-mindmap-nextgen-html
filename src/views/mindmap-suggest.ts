import { ButtonComponent, Modal, SuggestModal, TFile } from 'obsidian'

import { strings } from 'src/translation'
import { leafManager } from './leaf-manager'
import views from './views'

const MINDMAP_TAG = 'mindmap'

// Obsidian stores inline tags as "#mindmap" in metadataCache.tags, while
// frontmatter tags live separately in metadataCache.frontmatter.tags (as
// "mindmap" / "#mindmap" / arrays). Normalise both by stripping the '#'.
const normalizeTag = (tag: string) =>
  tag.replace(/^#/, '').toLowerCase()

function hasMindmapTag(file: TFile): boolean {
  const cache = app.metadataCache.getFileCache(file)
  if (!cache) return false
  const inlineTags = cache.tags?.map(tag => tag.tag) ?? []
  const fmTags: unknown = cache.frontmatter?.tags
  const fmList = typeof fmTags === 'string'
    ? [fmTags]
    : Array.isArray(fmTags)
      ? fmTags.map(String)
      : []
  return [...inlineTags, ...fmList]
    .some(tag => normalizeTag(tag) === MINDMAP_TAG)
}

function getMindmapFiles(): TFile[] {
  return app.vault.getMarkdownFiles().filter(hasMindmapTag)
}

// Simple subsequence fuzzy match (e.g. "mp" matches "my-mindmap").
function fuzzyMatch(text: string, query: string): boolean {
  const haystack = text.toLowerCase()
  const needle = query.toLowerCase()
  let index = 0
  for (const char of needle) {
    index = haystack.indexOf(char, index)
    if (index === -1) return false
    index++
  }
  return true
}

function openMindmap(file: TFile) {
  if (views.has(file)) {
    leafManager.reveal(file)
    return
  }
  // open as a regular tab (not a split) per user preference
  leafManager.new(file, true)
}

// Picker shown by the "Open mindmap" command: notes tagged #mindmap are
// listed by default; typing searches all notes (tag not required).
export class MindmapSuggestModal extends SuggestModal<TFile> {
  private mindmapFiles: TFile[]
  private allFiles: TFile[]

  constructor() {
    super(app)
    this.mindmapFiles = getMindmapFiles()
    this.allFiles = app.vault.getMarkdownFiles()
    this.setPlaceholder(strings.mindmapModal.placeholder)
    this.emptyStateText = strings.mindmapModal.emptyState
  }

  getSuggestions(query: string) {
    const trimmed = query.trim()
    if (!trimmed) {
      this.emptyStateText = strings.mindmapModal.emptyState
      return this.mindmapFiles
    }
    this.emptyStateText = strings.mindmapModal.noMatches
    return this.allFiles.filter(file =>
      fuzzyMatch(file.basename, trimmed) || fuzzyMatch(file.path, trimmed))
  }

  renderSuggestion(file: TFile, el: HTMLElement) {
    el.createDiv({ text: file.basename })
    if (file.parent && file.parent.path !== '/')
      el.createDiv({ cls: 'suggestion-note', text: file.path })
  }

  onChooseSuggestion(file: TFile) {
    if (hasMindmapTag(file)) {
      openMindmap(file)
      return
    }
    new ConfirmOpenMindmapModal(file).open()
  }
}

// Confirmation shown when the chosen note has no #mindmap tag.
class ConfirmOpenMindmapModal extends Modal {
  constructor(private file: TFile) {
    super(app)
  }

  onOpen() {
    const { contentEl } = this
    contentEl.createEl('h2', {
      text: strings.mindmapModal.confirmTitle.replace('{name}', this.file.basename)
    })
    contentEl.createEl('p', { text: strings.mindmapModal.confirmBody })

    const buttonRow = contentEl.createDiv({ cls: 'modal-button-container' })
    new ButtonComponent(buttonRow)
      .setButtonText(strings.mindmapModal.openAnyway)
      .setCta()
      .onClick(() => {
        this.close()
        openMindmap(this.file)
      })
    new ButtonComponent(buttonRow)
      .setButtonText(strings.mindmapModal.cancel)
      .onClick(() => this.close())
  }

  onClose() {
    this.contentEl.empty()
  }
}

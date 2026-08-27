import { ItemView, Menu, WorkspaceLeaf } from 'obsidian'

import { MM_VIEW_TYPE } from 'src/constants'
import { TabRenderer } from 'src/rendering/renderer-tab'
import { strings } from 'src/translation'
import Callbag from 'src/utilities/callbag'
import { Set } from 'src/utilities/set'


export default class MindmapView extends ItemView {
  private displayText: string
  private pinned: boolean
  
  private renderer: TabRenderer
  public render: TabRenderer['render']
  public firstRender: TabRenderer['firstRender']

  public static instances = new Set<MindmapView>()

  constructor(public leaf: WorkspaceLeaf, displayText: string, pinned: boolean) {
    super(leaf)
    MindmapView.instances.add(this)
    this.register(() =>
      MindmapView.instances.delete(this))

    this.displayText = displayText
    this.pinned = pinned

    this.renderer = TabRenderer(this.containerEl)
    this.render = this.renderer.render
    this.firstRender = this.renderer.firstRender
  }

  private static togglePinnedSubject = Callbag.subject<MindmapView>()
  public static togglePinned$ = this.togglePinnedSubject.source
  private togglePinned() {
    MindmapView.togglePinnedSubject.push(this)
  }

  public getViewType() { return MM_VIEW_TYPE }
  public getDisplayText() { return this.displayText }
  public getIcon() { return 'dot-network' }

  public setDisplayText(displayText: string) {
    this.displayText = displayText
    this.leaf.updateHeader()
  }

  public onPaneMenu(menu: Menu, source: string) {
    const { collapseAll, toolbar, downloadHtml } = this.renderer
    menu
      .addItem(item => item
        .setIcon('pin')
        .setTitle(this.pinned ? strings.menu.pin.unpin : strings.menu.pin.pin)
        .onClick(() => this.togglePinned())
      )
      .addSeparator()
      .addItem(item => item
        .setIcon('file-code')
        .setTitle(strings.menu.export.html)
        .onClick(downloadHtml)
      )
      .addSeparator()
      .addItem(item => item
        .setIcon('folder')
        .setTitle(strings.menu.collapseAll)
        .onClick(collapseAll)
      )
      .addItem(item => item
        .setIcon('view')
        .setTitle(`${toolbar.hidden ? strings.menu.toolbar.show : strings.menu.toolbar.hide} ${strings.menu.toolbar.toolbar}`)
        .onClick(toolbar.toggle)
      )

    super.onPaneMenu(menu, source)
  }
}

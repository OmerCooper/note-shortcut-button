const {
	Plugin,
	PluginSettingTab,
	Setting,
	Notice,
	FuzzySuggestModal,
	AbstractInputSuggest,
	TFile,
	TFolder,
	getIconIds,
	setIcon,
	requireApiVersion,
} = require("obsidian");

const DEFAULT_ICON = "file-text";
const DEFAULT_SETTINGS = { shortcuts: [] };
const MODIFIER_KEYS = ["Control", "Shift", "Alt", "Meta"];

// Accepts "Note", "folder/Note", "Note.md" or "[[Note|alias]]"
function cleanLink(link) {
	return (link || "")
		.trim()
		.replace(/^\[\[/, "")
		.replace(/\]\]$/, "")
		.split("|")[0]
		.split("#")[0]
		.trim();
}

// Turns a keydown event into a string like "Ctrl+Shift+T", or null for a bare modifier press
function hotkeyFromEvent(e) {
	if (MODIFIER_KEYS.includes(e.key)) return null;
	let key;
	if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
	else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
	else key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
	const parts = [];
	if (e.ctrlKey) parts.push("Ctrl");
	if (e.metaKey) parts.push("Cmd");
	if (e.altKey) parts.push("Alt");
	if (e.shiftKey) parts.push("Shift");
	parts.push(key);
	return parts.join("+");
}

module.exports = class NoteShortcutButtonPlugin extends Plugin {
	async onload() {
		const saved = await this.loadData();
		this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
		// First run: start with a shortcut to a TODO note if the vault has one
		if (!saved) this.app.workspace.onLayoutReady(() => this.addDefaultShortcut());
		this.ribbonEls = [];
		this.capturingHotkey = false;
		this.settingTab = new ShortcutSettingTab(this.app, this);
		this.addSettingTab(this.settingTab);
		this.registerHotkeyListener(window);
		this.registerEvent(this.app.workspace.on("window-open", (win) => this.registerHotkeyListener(win.win)));
		this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.onRename(file, oldPath)));
		// Wait for the vault index so links resolve on startup
		this.app.workspace.onLayoutReady(() => this.refreshRibbon());
	}

	onunload() {
		this.clearRibbon();
	}

	async addDefaultShortcut() {
		const todo = this.app.vault.getMarkdownFiles().find((f) => /todo/i.test(f.basename));
		if (!todo) return;
		this.settings.shortcuts.push({ link: todo.path.replace(/\.md$/, ""), icon: "list-todo", hotkey: "" });
		await this.saveSettings({ refreshTab: true });
	}

	// refreshTab: the shortcuts changed outside the settings tab, so redraw it too
	async saveSettings({ refreshTab = false } = {}) {
		await this.saveData(this.settings);
		this.refreshRibbon();
		if (refreshTab) this.settingTab.refresh();
	}

	// The ribbon keeps its own list of buttons and redraws from it, so removing the element alone
	// lets the button come back; removeRibbonAction is what Obsidian calls when a plugin unloads
	clearRibbon() {
		const ribbon = this.app.workspace.leftRibbon;
		for (const { el, title } of this.ribbonEls) {
			if (ribbon && typeof ribbon.removeRibbonAction === "function") {
				ribbon.removeRibbonAction(`${this.manifest.id}:${title}`);
			}
			el.remove();
		}
		this.ribbonEls = [];
	}

	refreshRibbon() {
		this.clearRibbon();
		for (const shortcut of this.settings.shortcuts) {
			const link = cleanLink(shortcut.link);
			if (!link) continue;
			const label = link.split("/").pop().replace(/\.md$/, "");
			const title = `Open ${label}`;
			const el = this.addRibbonIcon(shortcut.icon || DEFAULT_ICON, title, () => this.openNote(link));
			this.ribbonEls.push({ el, title });
		}
	}

	// Keep shortcut links pointing at notes (or folders of notes) that get renamed or moved
	async onRename(file, oldPath) {
		const stripMd = (p) => p.replace(/\.md$/, "");
		let changed = false;
		for (const shortcut of this.settings.shortcuts) {
			const link = cleanLink(shortcut.link);
			if (!link) continue;
			let newLink = null;
			if (file instanceof TFolder) {
				if (link.startsWith(oldPath + "/")) newLink = file.path + link.slice(oldPath.length);
			} else if (link === oldPath || link === stripMd(oldPath)) {
				newLink = file.extension === "md" ? stripMd(file.path) : file.path;
			} else if (!link.includes("/")) {
				// Bare note name: only update if it no longer resolves to some other note
				const oldName = stripMd(oldPath.split("/").pop());
				if ((link === oldName || link + ".md" === oldPath.split("/").pop()) && !this.resolveFile(link)) {
					newLink = file.extension === "md" ? stripMd(file.path) : file.path;
				}
			}
			if (newLink) {
				shortcut.link = newLink;
				changed = true;
			}
		}
		if (changed) await this.saveSettings({ refreshTab: true });
	}

	// Capture phase so our shortcuts win over Obsidian's own hotkeys
	registerHotkeyListener(win) {
		this.registerDomEvent(
			win,
			"keydown",
			(e) => {
				if (this.capturingHotkey) return;
				const pressed = hotkeyFromEvent(e);
				if (!pressed) return;
				const shortcut = this.settings.shortcuts.find((s) => s.hotkey && s.hotkey === pressed);
				if (!shortcut || !cleanLink(shortcut.link)) return;
				e.preventDefault();
				e.stopPropagation();
				this.openNote(cleanLink(shortcut.link));
			},
			{ capture: true }
		);
	}

	resolveFile(link) {
		return (
			this.app.metadataCache.getFirstLinkpathDest(link, "") ||
			this.app.vault.getAbstractFileByPath(link)
		);
	}

	async openNote(link) {
		const file = this.resolveFile(link);
		if (!(file instanceof TFile)) {
			new Notice(`Note not found: ${link}`);
			return;
		}
		// Reuse an already-open tab instead of opening a duplicate
		let existing = null;
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (!existing && leaf.view.file && leaf.view.file.path === file.path) existing = leaf;
		});
		if (existing) {
			this.app.workspace.setActiveLeaf(existing, { focus: true });
			return;
		}
		await this.app.workspace.getLeaf(false).openFile(file);
	}
};

class NoteSuggest extends AbstractInputSuggest {
	constructor(app, inputEl, onPick) {
		super(app, inputEl);
		this.inputEl = inputEl;
		this.onPick = onPick;
		// Only suggest while typing, not when the redrawn row gets focus back after a pick.
		// beforeinput fires before the input event the suggester listens to.
		this.typing = false;
		inputEl.addEventListener("beforeinput", () => (this.typing = true));
		inputEl.addEventListener("blur", () => (this.typing = false));
	}

	getSuggestions(query) {
		if (!this.typing) return [];
		const q = query.toLowerCase();
		return this.app.vault
			.getFiles()
			.filter((f) => ["md", "canvas"].includes(f.extension))
			.filter((f) => f.path.toLowerCase().includes(q))
			.slice(0, 50);
	}

	renderSuggestion(file, el) {
		el.setText(file.path);
	}

	selectSuggestion(file) {
		const value = file.extension === "md" ? file.path.replace(/\.md$/, "") : file.path;
		this.inputEl.value = value;
		this.typing = false;
		this.close();
		this.onPick(value);
	}
}

class IconPickerModal extends FuzzySuggestModal {
	constructor(app, onChoose) {
		super(app);
		this.onChoose = onChoose;
		this.setPlaceholder("Search icons (e.g. check, star, book)...");
	}

	getItems() {
		return getIconIds().map((id) => id.replace(/^lucide-/, ""));
	}

	getItemText(id) {
		return id;
	}

	renderSuggestion(match, el) {
		el.addClass("nscb-icon-suggestion");
		const iconEl = el.createSpan({ cls: "nscb-icon-preview" });
		setIcon(iconEl, match.item);
		el.createSpan({ text: match.item });
	}

	onChooseItem(id) {
		this.onChoose(id);
	}
}

const LIST_NAME = "Note shortcuts";
const LIST_DESC = "Each shortcut adds a button to the left panel that opens its note.";

class ShortcutSettingTab extends PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
		this.declarative = requireApiVersion("1.13.0");
	}

	get shortcuts() {
		return this.plugin.settings.shortcuts;
	}

	// Re-draw the tab after shortcuts are added, removed or changed
	refresh() {
		if (this.declarative) this.update();
		else this.display();
	}

	async addShortcut() {
		this.shortcuts.push({ link: "", icon: DEFAULT_ICON, hotkey: "" });
		await this.plugin.saveSettings();
		this.refresh();
	}

	async deleteShortcut(index) {
		this.shortcuts.splice(index, 1);
		await this.plugin.saveSettings();
		this.refresh();
	}

	async moveShortcut(from, to) {
		const [moved] = this.shortcuts.splice(from, 1);
		this.shortcuts.splice(to, 0, moved);
		await this.plugin.saveSettings();
		this.refresh();
	}

	// Obsidian 1.13+: drawn by Obsidian, with its own add, drag-to-reorder and delete controls
	getSettingDefinitions() {
		return [
			{
				type: "list",
				heading: LIST_NAME,
				emptyState: "No shortcuts yet. Click + to add one.",
				addItem: { name: "Add shortcut", action: () => this.addShortcut() },
				onDelete: (index) => this.deleteShortcut(index),
				onReorder: (from, to) => this.moveShortcut(from, to),
				items: this.shortcuts.map((shortcut, index) => ({
					name: cleanLink(shortcut.link).split("/").pop() || `Shortcut ${index + 1}`,
					searchable: false,
					render: (setting) => this.buildRow(setting, shortcut),
				})),
			},
		];
	}

	// Obsidian before 1.13 (not called when getSettingDefinitions is used)
	display() {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName(LIST_NAME)
			.setDesc(LIST_DESC)
			.addButton((btn) =>
				btn.setIcon("plus").setTooltip("Add shortcut").setCta().onClick(() => this.addShortcut())
			);

		this.shortcuts.forEach((shortcut, index) => {
			const setting = new Setting(containerEl).setName(cleanLink(shortcut.link).split("/").pop() || `Shortcut ${index + 1}`);
			this.buildRow(setting, shortcut);
			setting
				.addExtraButton((btn) =>
					btn
						.setIcon("arrow-up")
						.setTooltip("Move up")
						.setDisabled(index === 0)
						.onClick(() => index > 0 && this.moveShortcut(index, index - 1))
				)
				.addExtraButton((btn) =>
					btn.setIcon("trash").setTooltip("Delete shortcut").onClick(() => this.deleteShortcut(index))
				);
		});
	}

	buildRow(setting, shortcut) {
		const previewEl = createSpan({ cls: "nscb-icon-preview" });
		setIcon(previewEl, shortcut.icon || DEFAULT_ICON);
		setting.nameEl.prepend(previewEl);

		setting
			.addText((text) => {
				text
					.setPlaceholder("Note link, e.g. TODO")
					.setValue(shortcut.link)
					.onChange(async (value) => {
						shortcut.link = value;
						await this.plugin.saveSettings();
					});
				new NoteSuggest(this.app, text.inputEl, async (value) => {
					shortcut.link = value;
					await this.plugin.saveSettings();
					this.refresh();
				});
			})
			.addButton((btn) =>
				btn.setButtonText("Choose icon").onClick(() =>
					new IconPickerModal(this.app, async (id) => {
						shortcut.icon = id;
						await this.plugin.saveSettings();
						this.refresh();
					}).open()
				)
			)
			.addButton((btn) => {
				btn.buttonEl.addClass("nscb-hotkey-button");
				btn
					.setButtonText(shortcut.hotkey || "No shortcut")
					.setTooltip("Click, then press a key combination (Esc to cancel, Backspace to remove)")
					.onClick(() => this.captureHotkey(btn, shortcut));
			});

		if (shortcut.hotkey) {
			setting.addButton((btn) =>
				btn
					.setButtonText("No shortcut")
					.setWarning()
					.setTooltip("Remove this keyboard shortcut")
					.onClick(async () => {
						shortcut.hotkey = "";
						await this.plugin.saveSettings();
						this.refresh();
					})
			);
		}
	}

	captureHotkey(btn, shortcut) {
		if (this.plugin.capturingHotkey) return;
		this.plugin.capturingHotkey = true;
		btn.setButtonText("Press keys...");
		const win = btn.buttonEl.win || window;
		const onKey = async (e) => {
			e.preventDefault();
			e.stopPropagation();
			if (e.key === "Escape") return finish();
			if (e.key === "Backspace" || e.key === "Delete") {
				shortcut.hotkey = "";
				await this.plugin.saveSettings();
				return finish();
			}
			const pressed = hotkeyFromEvent(e);
			if (!pressed) return; // wait for a non-modifier key
			const clash = this.shortcuts.find((s) => s !== shortcut && s.hotkey === pressed);
			if (clash) {
				new Notice(`${pressed} was used by "${cleanLink(clash.link)}" - moved here.`);
				clash.hotkey = "";
			}
			shortcut.hotkey = pressed;
			await this.plugin.saveSettings();
			finish();
		};
		const stop = () => {
			win.removeEventListener("keydown", onKey, true);
			this.plugin.capturingHotkey = false;
			this.stopCapture = null;
		};
		const finish = () => {
			stop();
			this.refresh();
		};
		this.stopCapture = stop;
		win.addEventListener("keydown", onKey, true);
	}

	hide() {
		if (this.stopCapture) this.stopCapture();
	}
}

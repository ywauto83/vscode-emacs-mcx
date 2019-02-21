import * as vscode from "vscode";
import { Disposable, Position, Range, Selection, TextEditor } from "vscode";
import { instanceOfIEmacsCommandInterrupted } from "./commands";
import { DeleteBlankLines } from "./commands/delete-blank-lines";
import * as EditCommands from "./commands/edit";
import * as MoveCommands from "./commands/move";
import { BackwardSexp, BackwardUpSexp, ForwardDownSexp, ForwardSexp } from "./commands/paredit";
import { RecenterTopBottom } from "./commands/recenter";
import { EmacsCommandRegistry } from "./commands/registry";
import { EditorIdentity } from "./editorIdentity";
import { KillRing } from "./kill-ring";
import { KillYanker } from "./kill-yank";
import { MessageManager } from "./message";
import { PrefixArgumentHandler } from "./prefix-argument";

export class EmacsEmulator implements Disposable {
    private textEditor: TextEditor;

    private commandRegistry: EmacsCommandRegistry;

    // tslint:disable-next-line:variable-name
    private _isInMarkMode = false;
    public get isInMarkMode() {
        return this._isInMarkMode;
    }

    private killYanker: KillYanker;
    private prefixArgumentHandler: PrefixArgumentHandler;

    constructor(textEditor: TextEditor, killRing: KillRing | null = null) {
        this.textEditor = textEditor;

        this.killYanker = new KillYanker(textEditor, killRing);
        this.prefixArgumentHandler = new PrefixArgumentHandler();

        this.onDidChangeTextDocument = this.onDidChangeTextDocument.bind(this);
        vscode.workspace.onDidChangeTextDocument(this.onDidChangeTextDocument);
        this.onDidChangeTextEditorSelection = this.onDidChangeTextEditorSelection.bind(this);
        vscode.window.onDidChangeTextEditorSelection(this.onDidChangeTextEditorSelection);

        this.commandRegistry = new EmacsCommandRegistry();
        this.afterCommand = this.afterCommand.bind(this);

        this.commandRegistry.register(new MoveCommands.ForwardChar(this.afterCommand));
        this.commandRegistry.register(new MoveCommands.BackwardChar(this.afterCommand));
        this.commandRegistry.register(new MoveCommands.NextLine(this.afterCommand));
        this.commandRegistry.register(new MoveCommands.PreviousLine(this.afterCommand));
        this.commandRegistry.register(new MoveCommands.MoveBeginningOfLine(this.afterCommand));
        this.commandRegistry.register(new MoveCommands.MoveEndOfLine(this.afterCommand));
        this.commandRegistry.register(new MoveCommands.ForwardWord(this.afterCommand));
        this.commandRegistry.register(new MoveCommands.BackwardWord(this.afterCommand));
        this.commandRegistry.register(new MoveCommands.BeginningOfBuffer(this.afterCommand));
        this.commandRegistry.register(new MoveCommands.EndOfBuffer(this.afterCommand));
        this.commandRegistry.register(new MoveCommands.ScrollUpCommand(this.afterCommand));
        this.commandRegistry.register(new MoveCommands.ScrollDownCommand(this.afterCommand));
        this.commandRegistry.register(new EditCommands.DeleteBackwardChar(this.afterCommand));
        this.commandRegistry.register(new EditCommands.DeleteForwardChar(this.afterCommand));
        this.commandRegistry.register(new EditCommands.NewLine(this.afterCommand));
        this.commandRegistry.register(new DeleteBlankLines(this.afterCommand));

        this.commandRegistry.register(new ForwardSexp(this.afterCommand));
        this.commandRegistry.register(new BackwardSexp(this.afterCommand));
        this.commandRegistry.register(new ForwardDownSexp (this.afterCommand));
        this.commandRegistry.register(new BackwardUpSexp (this.afterCommand));

        this.commandRegistry.register(new RecenterTopBottom(this.afterCommand));

        // TODO: I want to use a decorator
        this.killLine = this.makePrefixArgumentAcceptable(this.killLine);
    }

    public setTextEditor(textEditor: TextEditor) {
        this.textEditor = textEditor;
        this.killYanker.setTextEditor(textEditor);
    }

    public getTextEditor(): TextEditor {
        return this.textEditor;
    }

    public onDidChangeTextDocument(e: vscode.TextDocumentChangeEvent) {
        // XXX: Is this a correct way to check the identity of document?
        if (e.document.uri.toString() === this.textEditor.document.uri.toString()) {
            if (e.contentChanges.some((contentChange) =>
                this.textEditor.selections.some((selection) =>
                    typeof contentChange.range.intersection(selection) !== "undefined",
                ),
            )) {
                this.exitMarkMode();
            }

            this.onDidInterruptTextEditor();
        }
    }

    public onDidChangeTextEditorSelection(e: vscode.TextEditorSelectionChangeEvent) {
        if (new EditorIdentity(e.textEditor).isEqual(new EditorIdentity(this.textEditor))) {
            this.onDidInterruptTextEditor();
        }
    }

    // tslint:disable-next-line:max-line-length
    // Ref: https://github.com/Microsoft/vscode-extension-samples/blob/f9955406b4cad550fdfa891df23a84a2b344c3d8/vim-sample/src/extension.ts#L152
    public type(text: string) {
        const handled = this.prefixArgumentHandler.handleType(text);
        if (handled) { return; }

        // Single character input with prefix argument
        const prefixArgument = this.prefixArgumentHandler.getPrefixArgument();
        this.prefixArgumentHandler.cancel();

        if (prefixArgument !== undefined && prefixArgument >= 0) {
            const promises = [];
            for (let i = 0; i < prefixArgument; ++i) {
                const promise = vscode.commands.executeCommand("default:type", {
                    text,
                });
                promises.push(promise);
            }
            // NOTE: Current implementation executes promises concurrently. Should it be sequential?
            return Promise.all(promises);
        }

        return vscode.commands.executeCommand("default:type", {
            text,
        });
    }

    public universalArgument() {
        this.prefixArgumentHandler.universalArgument();
    }

    public runCommand(commandName: string) {
        const command = this.commandRegistry.get(commandName);

        if (command === undefined) {
            throw Error(`command ${commandName} is not found`);
        }

        if (command !== undefined) {
            const prefixArgument = this.prefixArgumentHandler.getPrefixArgument();

            return command.run(this.textEditor, this.isInMarkMode, prefixArgument);
        }
    }

    public setMarkCommand() {
        if (this.isInMarkMode && !this.hasNonEmptySelection()) {
            // Toggle if enterMarkMode is invoked continuously without any cursor move.
            this.exitMarkMode();
            MessageManager.showMessage("Mark deactivated");
        } else {
            this.enterMarkMode();
            MessageManager.showMessage("Mark activated");
        }
    }

    public addSelectionToNextFindMatch() {
        this.enterMarkMode();
        return vscode.commands.executeCommand("editor.action.addSelectionToNextFindMatch");
    }

    public addSelectionToPreviousFindMatch() {
        this.enterMarkMode();
        return vscode.commands.executeCommand("editor.action.addSelectionToPreviousFindMatch");
    }

    /**
     * Invoked by C-g
     */
    public cancel() {
        if (this.hasMultipleSelections() && !this.hasNonEmptySelection()) {
            this.stopMultiCursor();
        } else {
            this.makeSelectionsEmpty();
        }

        if (this.isInMarkMode) {
            this.exitMarkMode();
        }

        this.onDidInterruptTextEditor();

        this.killYanker.cancelKillAppend();
        this.prefixArgumentHandler.cancel();

        MessageManager.showMessage("Quit");
    }

    public copyRegion() {
        const ranges = this.getNonEmptySelections();
        this.killYanker.copy(ranges);
        this.cancel();
    }

    // tslint:disable-next-line:no-unnecessary-initializer
    public killLine(prefixArgument: number | undefined = undefined) {
        const ranges = this.textEditor.selections.map((selection) => {
            const cursor = selection.anchor;
            const lineAtCursor = this.textEditor.document.lineAt(cursor.line);

            if (prefixArgument !== undefined) {
                return new Range(cursor, new Position(cursor.line + prefixArgument, 0));
            }

            const lineEnd = lineAtCursor.range.end;

            if (cursor.isEqual(lineEnd)) {
                // From the end of the line to the beginning of the next line
                return new Range(cursor, new Position(cursor.line + 1, 0));
            } else {
                // From the current cursor to the end of line
                return new Range(cursor, lineEnd);
            }
        });
        this.exitMarkMode();
        return this.killYanker.kill(ranges);
    }

    public killWholeLine() {
        const ranges = this.textEditor.selections.map((selection) =>
            // From the beginning of the line to the beginning of the next line
            new Range(
                new Position(selection.anchor.line, 0),
                new Position(selection.anchor.line + 1, 0),
            ),
        );
        this.exitMarkMode();
        return this.killYanker.kill(ranges);
    }

    public async killRegion() {
        const ranges = this.getNonEmptySelections();
        await this.killYanker.kill(ranges);
        this.exitMarkMode();
        this.cancelKillAppend();
    }

    public cancelKillAppend() {
        this.killYanker.cancelKillAppend();
    }

    public async yank() {
        await this.killYanker.yank();
        this.exitMarkMode();
    }

    public async yankPop() {
        await this.killYanker.yankPop();
        this.exitMarkMode();
    }

    public async newLine() {
        this.exitMarkMode();

        await this.runCommand("newLine");
    }

    public async transformToUppercase() {
        if (!this.hasNonEmptySelection()) {
            await this.runCommand("forwardWord");
        }
        await vscode.commands.executeCommand("editor.action.transformToUppercase");
    }

    public async transformToLowercase() {
        if (!this.hasNonEmptySelection()) {
            await this.runCommand("forwardWord");
        }
        await vscode.commands.executeCommand("editor.action.transformToLowercase");
    }

    public dispose() {
        delete this.killYanker;
    }

    private enterMarkMode() {
        this._isInMarkMode = true;

        // At this moment, the only way to set the context for `when` conditions is `setContext` command.
        // The discussion is ongoing in https://github.com/Microsoft/vscode/issues/10471
        // TODO: How to write unittest for `setContext`?
        vscode.commands.executeCommand("setContext", "emacs-mcx.inMarkMode", true);
    }

    private exitMarkMode() {
        this._isInMarkMode = false;
        vscode.commands.executeCommand("setContext", "emacs-mcx.inMarkMode", false);
    }

    private makePrefixArgumentAcceptable(method: (...args: any[]) => any) {
        return (...args: any[]) => {
            const prefixArgument = this.prefixArgumentHandler.getPrefixArgument();

            const ret = method.apply(this, [...args, prefixArgument]);

            this.prefixArgumentHandler.cancel();

            return ret;
        };
    }

    private makeSelectionsEmpty() {
        this.textEditor.selections = this.textEditor.selections.map((selection) =>
            new Selection(selection.active, selection.active));
    }

    private stopMultiCursor() {
        vscode.commands.executeCommand("removeSecondaryCursors");
    }

    private hasMultipleSelections(): boolean {
        return this.textEditor.selections.length > 1;
    }

    private hasNonEmptySelection(): boolean {
        return this.textEditor.selections.some((selection) => !selection.isEmpty);
    }

    private getNonEmptySelections(): Selection[] {
        return this.textEditor.selections.filter((selection) => !selection.isEmpty);
    }

    private afterCommand() {
        this.prefixArgumentHandler.cancel();
    }

    private onDidInterruptTextEditor() {
        this.commandRegistry.forEach((command) => {
            if (instanceOfIEmacsCommandInterrupted(command)) {
                command.onDidInterruptTextEditor();
            }
        });
    }
}

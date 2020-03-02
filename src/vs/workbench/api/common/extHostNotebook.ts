/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as glob from 'vs/base/common/glob';
import { ExtHostNotebookShape, IMainContext, MainThreadNotebookShape, MainContext, ICellDto, NotebookCellsSplice, NotebookCellOutputsSplice } from 'vs/workbench/api/common/extHost.protocol';
import { IExtensionDescription } from 'vs/platform/extensions/common/extensions';
import { Disposable as VSCodeDisposable } from './extHostTypes';
import { URI, UriComponents } from 'vs/base/common/uri';
import { DisposableStore } from 'vs/base/common/lifecycle';
import { readonly } from 'vs/base/common/errors';
import { Emitter, Event } from 'vs/base/common/event';
import { ExtHostDocumentsAndEditors } from 'vs/workbench/api/common/extHostDocumentsAndEditors';
import { INotebookDisplayOrder, parseCellUri, parseCellHandle, ITransformedDisplayOutputDto, IOrderedMimeType, IStreamOutput, IErrorOutput, mimeTypeSupportedByCore } from 'vs/workbench/contrib/notebook/common/notebookCommon';
import { ISplice } from 'vs/base/common/sequence';

interface ExtHostOutputDisplayOrder {
	defaultOrder: glob.ParsedPattern[];
	userOrder?: glob.ParsedPattern[];
}

interface IMutableSplice<T> extends ISplice<T> {
	deleteCount: number;
}

function diff<T>(before: T[], after: T[], contains: (a: T) => boolean): ISplice<T>[] {
	const result: IMutableSplice<T>[] = [];

	function pushSplice(start: number, deleteCount: number, toInsert: T[]): void {
		if (deleteCount === 0 && toInsert.length === 0) {
			return;
		}

		const latest = result[result.length - 1];

		if (latest && latest.start + latest.deleteCount === start) {
			latest.deleteCount += deleteCount;
			latest.toInsert.push(...toInsert);
		} else {
			result.push({ start, deleteCount, toInsert });
		}
	}

	let beforeIdx = 0;
	let afterIdx = 0;

	while (true) {
		if (beforeIdx === before.length) {
			pushSplice(beforeIdx, 0, after.slice(afterIdx));
			break;
		}

		if (afterIdx === after.length) {
			pushSplice(beforeIdx, before.length - beforeIdx, []);
			break;
		}

		const beforeElement = before[beforeIdx];
		const afterElement = after[afterIdx];

		if (beforeElement === afterElement) {
			// equal
			beforeIdx += 1;
			afterIdx += 1;
			continue;
		}

		if (contains(afterElement)) {
			// `afterElement` exists before, which means some elements before `afterElement` are deleted
			pushSplice(beforeIdx, 1, []);
			beforeIdx += 1;
		} else {
			// `afterElement` added
			pushSplice(beforeIdx, 0, [afterElement]);
			afterIdx += 1;
		}
	}

	return result;
}


export class ExtHostCell implements vscode.NotebookCell {

	private static _handlePool: number = 0;
	readonly handle = ExtHostCell._handlePool++;
	public source: string[];
	private _outputs: any[];
	private _onDidChangeOutputs = new Emitter<ISplice<vscode.CellOutput>[]>();
	onDidChangeOutputs: Event<ISplice<vscode.CellOutput>[]> = this._onDidChangeOutputs.event;
	private _textDocument: vscode.TextDocument | undefined;
	private _initalVersion: number = -1;
	private _outputMapping = new Set<vscode.CellOutput>();

	constructor(
		private _content: string,
		public cell_type: 'markdown' | 'code',
		public language: string,
		outputs: any[]
	) {
		this.source = this._content.split(/\r|\n|\r\n/g);
		this._outputs = outputs;
	}

	get outputs() {
		return this._outputs;
	}

	set outputs(newOutputs: any[]) {
		let diffs = diff<vscode.CellOutput>(this._outputs || [], newOutputs || [], (a) => {
			return this._outputMapping.has(a);
		});

		diffs.forEach(diff => {
			for (let i = diff.start; i < diff.start + diff.deleteCount; i++) {
				this._outputMapping.delete(this._outputs[i]);
			}

			diff.toInsert.forEach(output => {
				this._outputMapping.add(output);
			});
		});

		this._outputs = newOutputs;
		this._onDidChangeOutputs.fire(diffs);
	}

	getContent(): string {
		if (this._textDocument && this._initalVersion !== this._textDocument?.version) {
			return this._textDocument.getText();
		} else {
			return this.source.join('\n');
		}
	}

	attachTextDocument(document: vscode.TextDocument) {
		this._textDocument = document;
		this._initalVersion = this._textDocument.version;
	}

	detachTextDocument(document: vscode.TextDocument) {
		if (this._textDocument && this._textDocument.version !== this._initalVersion) {
			this.source = this._textDocument.getText().split(/\r|\n|\r\n/g);
		}

		this._textDocument = undefined;
		this._initalVersion = -1;
	}
}


export class ExtHostNotebookDocument implements vscode.NotebookDocument, vscode.Disposable {
	private static _handlePool: number = 0;
	readonly handle = ExtHostNotebookDocument._handlePool++;

	private _cells: ExtHostCell[] = [];

	private _cellDisposableMapping = new Map<number, DisposableStore>();

	get cells() {
		return this._cells;
	}

	set cells(newCells: ExtHostCell[]) {
		let diffs = diff<ExtHostCell>(this._cells, newCells, (a) => {
			return this._cellDisposableMapping.has(a.handle);
		});

		diffs.forEach(diff => {
			for (let i = diff.start; i < diff.start + diff.deleteCount; i++) {
				this._cellDisposableMapping.get(this._cells[i].handle)?.clear();
				this._cellDisposableMapping.delete(this._cells[i].handle);
			}

			diff.toInsert.forEach(cell => {
				this._cellDisposableMapping.set(cell.handle, new DisposableStore());
				this._cellDisposableMapping.get(cell.handle)?.add(cell.onDidChangeOutputs((outputDiffs) => {
					this.eventuallyUpdateCellOutputs(cell, outputDiffs);
				}));
			});
		});

		this._cells = newCells;
		this.eventuallyUpdateCells(diffs);
	}

	private _languages: string[] = [];

	get languages() {
		return this._languages = [];
	}

	set languages(newLanguages: string[]) {
		this._languages = newLanguages;
		this._proxy.$updateNotebookLanguages(this.viewType, this.uri, this._languages);
	}

	private _displayOrder: vscode.GlobPattern[] = [];
	private _parsedDisplayOrder: glob.ParsedPattern[] = [];

	get displayOrder() {
		return this._displayOrder;
	}

	set displayOrder(newOrder: vscode.GlobPattern[]) {
		this._displayOrder = newOrder;
		this._parsedDisplayOrder = newOrder.map(pattern => glob.parse(pattern));
	}

	get parsedDisplayOrder() {
		return this._parsedDisplayOrder;
	}

	constructor(
		private readonly _proxy: MainThreadNotebookShape,
		public viewType: string,
		public uri: URI,
		public renderingHandler: ExtHostNotebookOutputRenderingHandler
	) {

	}
	dispose() {
		this._cellDisposableMapping.forEach(cell => cell.dispose());
	}

	get fileName() { return this.uri.fsPath; }

	get isDirty() { return false; }

	eventuallyUpdateCells(diffs: ISplice<ExtHostCell>[]) {
		let renderers = new Set<number>();
		let diffDtos: NotebookCellsSplice[] = [];

		diffDtos = diffs.map(diff => {
			let inserts = diff.toInsert;

			let cellDtos = inserts.map(cell => {
				let outputs = cell.outputs;
				if (outputs && outputs.length) {
					outputs = outputs.map(output => {
						if (output.output_type === 'display_data' || output.output_type === 'execute_result') {
							const ret = this.transformMimeTypes(cell, output);

							if (ret.orderedMimeTypes[ret.pickedMimeTypeIndex].isResolved) {
								renderers.add(ret.orderedMimeTypes[ret.pickedMimeTypeIndex].rendererId!);
							}
							return ret;
						} else {
							return output;
						}
					});
				}

				return {
					handle: cell.handle,
					source: cell.source,
					language: cell.language,
					cell_type: cell.cell_type,
					outputs: outputs,
					isDirty: false
				};
			});

			return [diff.start, diff.deleteCount, cellDtos];
		});

		this._proxy.$spliceNotebookCells(
			this.viewType,
			this.uri,
			diffDtos,
			Array.from(renderers)
		);
	}

	eventuallyUpdateCellOutputs(cell: ExtHostCell, diffs: ISplice<vscode.CellOutput>[]) {
		let renderers = new Set<number>();
		let outputDtos: NotebookCellOutputsSplice[] = diffs.map(diff => {
			let outputs = diff.toInsert;

			let transformedOutputs = outputs.map(output => {
				if (output.output_type === 'display_data' || output.output_type === 'execute_result') {
					const ret = this.transformMimeTypes(cell, output);

					if (ret.orderedMimeTypes[ret.pickedMimeTypeIndex].isResolved) {
						renderers.add(ret.orderedMimeTypes[ret.pickedMimeTypeIndex].rendererId!);
					}
					return ret;
				} else {
					return output as IStreamOutput | IErrorOutput;
				}
			});

			return [diff.start, diff.deleteCount, transformedOutputs];
		});

		this._proxy.$spliceNotebookCellOutputs(this.viewType, this.uri, cell.handle, outputDtos, Array.from(renderers));
	}

	insertCell(index: number, cell: ExtHostCell) {
		this.cells.splice(index, 0, cell);

		if (!this._cellDisposableMapping.has(cell.handle)) {
			this._cellDisposableMapping.set(cell.handle, new DisposableStore());
		}

		let store = this._cellDisposableMapping.get(cell.handle)!;

		store.add(cell.onDidChangeOutputs((diffs) => {
			this.eventuallyUpdateCellOutputs(cell, diffs);
		}));
	}

	deleteCell(index: number): boolean {
		if (index >= this.cells.length) {
			return false;
		}

		let cell = this.cells[index];
		this._cellDisposableMapping.get(cell.handle)?.dispose();
		this._cellDisposableMapping.delete(cell.handle);

		this.cells.splice(index, 1);
		return true;
	}


	transformMimeTypes(cell: ExtHostCell, output: vscode.CellDisplayOutput): ITransformedDisplayOutputDto {
		let mimeTypes = Object.keys(output.data);

		const sorted = mimeTypes.sort((a, b) => {
			return this.getMimeTypeOrder(a) - this.getMimeTypeOrder(b);
		});

		let orderMimeTypes: IOrderedMimeType[] = [];

		sorted.forEach(mimeType => {
			let handlers = this.renderingHandler.findBestMatchedRenderer(mimeType);

			if (handlers.length) {
				let renderedOutput = handlers[0].render(this, cell, output, mimeType);

				orderMimeTypes.push({
					mimeType: mimeType,
					isResolved: true,
					rendererId: handlers[0].handle,
					output: renderedOutput
				});

				for (let i = 1; i < handlers.length; i++) {
					orderMimeTypes.push({
						mimeType: mimeType,
						isResolved: false,
						rendererId: handlers[i].handle
					});
				}

				if (mimeTypeSupportedByCore(mimeType)) {
					orderMimeTypes.push({
						mimeType: mimeType,
						isResolved: false,
						rendererId: -1
					});
				}
			} else {
				orderMimeTypes.push({
					mimeType: mimeType,
					isResolved: false
				});
			}
		});

		return {
			output_type: output.output_type,
			data: output.data,
			orderedMimeTypes: orderMimeTypes,
			pickedMimeTypeIndex: 0
		};
	}

	findRichestMimeType(output: vscode.CellOutput) {
		if (output.output_type === 'display_data' || output.output_type === 'execute_result') {
			let mimeTypes = Object.keys(output.data);

			const sorted = mimeTypes.sort((a, b) => {
				return this.getMimeTypeOrder(a) - this.getMimeTypeOrder(b);
			});

			if (sorted.length) {
				return sorted[0];
			}
		}

		return undefined;
	}

	getMimeTypeOrder(mimeType: string) {
		let order = 0;
		let coreDisplayOrder = this.renderingHandler.outputDisplayOrder;
		if (coreDisplayOrder) {
			// User order has highest priority
			let userDisplayOrder = coreDisplayOrder.userOrder;

			if (userDisplayOrder) {
				for (let i = 0; i < userDisplayOrder.length; i++) {
					if (userDisplayOrder[i](mimeType)) {
						return order;
					}
					order++;
				}
			}

			let documentDisplayOrder = this._parsedDisplayOrder;

			for (let i = 0; i < documentDisplayOrder.length; i++) {
				if (documentDisplayOrder[i](mimeType)) {
					return order;
				}

				order++;
			}

			let defaultOrder = coreDisplayOrder.defaultOrder;

			for (let i = 0; i < defaultOrder.length; i++) {
				if (defaultOrder[i](mimeType)) {
					return order;
				}

				order++;
			}
		}

		return order;
	}

	getCell(cellHandle: number) {
		return this.cells.find(cell => cell.handle === cellHandle);
	}

	attachCellTextDocument(cellHandle: number, textDocument: vscode.TextDocument) {
		let cell = this.cells.find(cell => cell.handle === cellHandle);

		if (cell) {
			cell.attachTextDocument(textDocument);
		}
	}

	detachCellTextDocument(cellHandle: number, textDocument: vscode.TextDocument) {
		let cell = this.cells.find(cell => cell.handle === cellHandle);

		if (cell) {
			cell.detachTextDocument(textDocument);
		}
	}
}

export class ExtHostNotebookEditor implements vscode.NotebookEditor, vscode.Disposable {
	private _viewColumn: vscode.ViewColumn | undefined;
	private _disposableStore = new DisposableStore();

	constructor(
		viewType: string,
		readonly id: string,
		public uri: URI,
		public document: ExtHostNotebookDocument,
		private _documentsAndEditors: ExtHostDocumentsAndEditors
	) {
		this._disposableStore.add(this._documentsAndEditors.onDidAddDocuments(documents => {
			for (const data of documents) {
				let textDocument = data.document;
				let parsedCellUri = parseCellUri(textDocument.uri);

				if (!parsedCellUri) {
					continue;
				}

				let notebookUri = parsedCellUri.notebook;
				let cellFsPath = textDocument.uri.fsPath;

				const cellHandle = parseCellHandle(cellFsPath);

				if (cellHandle !== undefined) {
					if (this.document.uri.fsPath === notebookUri.fsPath) {
						document.attachCellTextDocument(Number(cellHandle), textDocument);
					}
				}
			}
		}));

		this._disposableStore.add(this._documentsAndEditors.onDidRemoveDocuments(documents => {
			for (const data of documents) {
				let textDocument = data.document;
				let parsedCellUri = parseCellUri(textDocument.uri);

				if (!parsedCellUri) {
					continue;
				}

				let notebookUri = parsedCellUri.notebook;
				let cellFsPath = textDocument.uri.fsPath;

				const cellHandle = parseCellHandle(cellFsPath);

				if (cellHandle !== undefined) {
					if (this.document.uri.fsPath === notebookUri.fsPath) {
						document.detachCellTextDocument(Number(cellHandle), textDocument);
					}
				}
			}
		}));
	}

	dispose() {
		this._disposableStore.dispose();
	}

	createCell(content: string, language: string, type: 'markdown' | 'code', outputs: vscode.CellOutput[]): vscode.NotebookCell {
		let cell = new ExtHostCell(content, type, language, outputs);
		return cell;
	}

	get viewColumn(): vscode.ViewColumn | undefined {
		return this._viewColumn;
	}

	set viewColumn(value) {
		throw readonly('viewColumn');
	}
}

export class ExtHostNotebookOutputRenderer {
	private static _handlePool: number = 0;
	readonly handle = ExtHostNotebookOutputRenderer._handlePool++;

	constructor(
		public type: string,
		public filter: vscode.NotebookOutputSelector,
		public renderer: vscode.NotebookOutputRenderer
	) {

	}

	matches(mimeType: string): boolean {
		if (this.filter.subTypes) {
			if (this.filter.subTypes.indexOf(mimeType) >= 0) {
				return true;
			}
		}
		return false;
	}

	render(document: ExtHostNotebookDocument, cell: ExtHostCell, output: vscode.CellOutput, mimeType: string): string {
		let html = this.renderer.render(document, cell, output, mimeType);

		return html;
		// return {
		// 	output_type: 'display_data',
		// 	data: {
		// 		'text/html': [
		// 			html
		// 		]
		// 	}
		// };
	}
}

export interface ExtHostNotebookOutputRenderingHandler {
	outputDisplayOrder: ExtHostOutputDisplayOrder | undefined;
	findBestMatchedRenderer(mimeType: string): ExtHostNotebookOutputRenderer[];
}

export class ExtHostNotebookController implements ExtHostNotebookShape, ExtHostNotebookOutputRenderingHandler {
	private static _handlePool: number = 0;

	private readonly _proxy: MainThreadNotebookShape;
	private readonly _notebookProviders = new Map<string, { readonly provider: vscode.NotebookProvider, readonly extension: IExtensionDescription }>();
	private readonly _documents = new Map<string, ExtHostNotebookDocument>();
	private readonly _editors = new Map<string, ExtHostNotebookEditor>();
	private readonly _notebookOutputRenderers = new Map<number, ExtHostNotebookOutputRenderer>();
	private _outputDisplayOrder: ExtHostOutputDisplayOrder | undefined;

	get outputDisplayOrder(): ExtHostOutputDisplayOrder | undefined {
		return this._outputDisplayOrder;
	}

	private _activeNotebookDocument: ExtHostNotebookDocument | undefined;

	get activeNotebookDocument() {
		return this._activeNotebookDocument;
	}

	constructor(mainContext: IMainContext, private _documentsAndEditors: ExtHostDocumentsAndEditors) {
		this._proxy = mainContext.getProxy(MainContext.MainThreadNotebook);
	}

	registerNotebookOutputRenderer(
		type: string,
		extension: IExtensionDescription,
		filter: vscode.NotebookOutputSelector,
		renderer: vscode.NotebookOutputRenderer
	): vscode.Disposable {
		let extHostRenderer = new ExtHostNotebookOutputRenderer(type, filter, renderer);
		this._notebookOutputRenderers.set(extHostRenderer.handle, extHostRenderer);
		this._proxy.$registerNotebookRenderer({ id: extension.identifier, location: extension.extensionLocation }, type, filter, extHostRenderer.handle, renderer.preloads || []);
		return new VSCodeDisposable(() => {
			this._notebookOutputRenderers.delete(extHostRenderer.handle);
			this._proxy.$unregisterNotebookRenderer(extHostRenderer.handle);
		});
	}

	findBestMatchedRenderer(mimeType: string): ExtHostNotebookOutputRenderer[] {
		let matches: ExtHostNotebookOutputRenderer[] = [];
		for (let renderer of this._notebookOutputRenderers) {
			if (renderer[1].matches(mimeType)) {
				matches.push(renderer[1]);
			}
		}

		return matches;
	}

	registerNotebookProvider(
		extension: IExtensionDescription,
		viewType: string,
		provider: vscode.NotebookProvider,
	): vscode.Disposable {

		if (this._notebookProviders.has(viewType)) {
			throw new Error(`Notebook provider for '${viewType}' already registered`);
		}

		this._notebookProviders.set(viewType, { extension, provider });
		this._proxy.$registerNotebookProvider({ id: extension.identifier, location: extension.extensionLocation }, viewType);
		return new VSCodeDisposable(() => {
			this._notebookProviders.delete(viewType);
			this._proxy.$unregisterNotebookProvider(viewType);
		});
	}

	async $resolveNotebook(viewType: string, uri: UriComponents): Promise<number | undefined> {
		let provider = this._notebookProviders.get(viewType);

		if (provider) {
			if (!this._documents.has(URI.revive(uri).toString())) {
				let document = new ExtHostNotebookDocument(this._proxy, viewType, URI.revive(uri), this);
				await this._proxy.$createNotebookDocument(
					document.handle,
					viewType,
					uri
				);

				this._documents.set(URI.revive(uri).toString(), document);
			}

			let editor = new ExtHostNotebookEditor(
				viewType,
				`${ExtHostNotebookController._handlePool++}`,
				URI.revive(uri),
				this._documents.get(URI.revive(uri).toString())!,
				this._documentsAndEditors
			);

			this._editors.set(URI.revive(uri).toString(), editor);
			await provider.provider.resolveNotebook(editor);
			// await editor.document.$updateCells();
			return editor.document.handle;
		}

		return Promise.resolve(undefined);
	}

	async $executeNotebook(viewType: string, uri: UriComponents, cellHandle: number | undefined): Promise<void> {
		let provider = this._notebookProviders.get(viewType);

		if (!provider) {
			return;
		}

		let document = this._documents.get(URI.revive(uri).toString());

		if (!document) {
			return;
		}

		let cell = cellHandle !== undefined ? document.getCell(cellHandle) : undefined;
		return provider.provider.executeCell(document!, cell);
	}

	async $createEmptyCell(viewType: string, uri: URI, index: number, language: string, type: 'markdown' | 'code'): Promise<ICellDto | undefined> {
		let provider = this._notebookProviders.get(viewType);

		if (provider) {
			let editor = this._editors.get(URI.revive(uri).toString());
			let document = this._documents.get(URI.revive(uri).toString());

			let rawCell = editor?.createCell('', language, type, []) as ExtHostCell;
			document?.insertCell(index, rawCell!);

			let allDocuments = this._documentsAndEditors.allDocuments();
			for (let i = 0; i < allDocuments.length; i++) {
				let textDocument = allDocuments[i].document;
				let parsedCellUri = parseCellUri(textDocument.uri);

				if (!parsedCellUri) {
					continue;
				}

				let notebookUri = parsedCellUri.notebook;
				let cellFsPath = textDocument.uri.fsPath;
				const cellHandle = parseCellHandle(cellFsPath);

				if (cellHandle !== undefined) {
					if (uri.fsPath === notebookUri.fsPath && Number(cellHandle) === rawCell.handle) {
						rawCell.attachTextDocument(textDocument);
					}

				}
			}


			return {
				handle: rawCell.handle,
				source: rawCell.source,
				language: rawCell.language,
				cell_type: rawCell.cell_type,
				outputs: rawCell.outputs
			};
		}

		return;
	}

	async $deleteCell(viewType: string, uri: UriComponents, index: number): Promise<boolean> {
		let provider = this._notebookProviders.get(viewType);

		if (provider) {
			let document = this._documents.get(URI.revive(uri).toString());

			if (document) {
				return document.deleteCell(index);
			}

			return false;
		}

		return false;
	}

	async $saveNotebook(viewType: string, uri: UriComponents): Promise<boolean> {
		let provider = this._notebookProviders.get(viewType);
		let document = this._documents.get(URI.revive(uri).toString());

		if (provider && document) {
			return await provider.provider.save(document);
		}

		return false;
	}

	async $updateActiveEditor(viewType: string, uri: UriComponents): Promise<void> {
		let document = this._documents.get(URI.revive(uri).toString());

		if (document) {
			this._activeNotebookDocument = document;
		} else {
			this._activeNotebookDocument = undefined;
		}
	}

	async $destoryNotebookDocument(viewType: string, uri: UriComponents): Promise<boolean> {
		let provider = this._notebookProviders.get(viewType);

		if (provider) {
			let document = this._documents.get(URI.revive(uri).toString());

			if (document) {
				document.dispose();
				this._documents.delete(URI.revive(uri).toString());
			}

			let editor = this._editors.get(URI.revive(uri).toString());

			if (editor) {
				editor.dispose();
				this._editors.delete(URI.revive(uri).toString());
			}

			return true;
		}

		return false;
	}

	$acceptDisplayOrder(displayOrder: INotebookDisplayOrder): void {
		let parsedDefaultDisplayOrder = displayOrder.defaultOrder.map(pattern => glob.parse(pattern));
		let parsedUserPattern = displayOrder.userOrder?.map(pattern => glob.parse(pattern));
		this._outputDisplayOrder = {
			defaultOrder: parsedDefaultDisplayOrder,
			userOrder: parsedUserPattern
		};
	}
}
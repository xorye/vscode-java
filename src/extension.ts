
'use strict';
import * as path from 'path';
import { workspace, extensions, ExtensionContext, window, StatusBarAlignment, commands, ViewColumn, Uri, CancellationToken, TextDocumentContentProvider, TextEditor, WorkspaceConfiguration, languages, IndentAction, ProgressLocation, Progress, env, version } from 'vscode';
import { ExecuteCommandParams, ExecuteCommandRequest, LanguageClient, LanguageClientOptions, RevealOutputChannelOn, ServerOptions, Position as LSPosition, Location as LSLocation } from 'vscode-languageclient';
import { collectionJavaExtensions, collectJavaExtensionContributors } from './plugin'
import { prepareExecutable, awaitServerConnection } from './javaServerStarter';
import * as requirements from './requirements';
import { Commands } from './commands';
import { StatusNotification, ClassFileContentsRequest, ProjectConfigurationUpdateRequest, MessageType, ActionableNotification, FeatureStatus, ActionableMessage } from './protocol';
const pathExists = require('path-exists');
const fs = require('fs');
let os = require('os');
const publicIp = require('public-ip');

let Analytics = require('analytics-node');
let oldConfig;
let lastStatus;
let analytics;
let telemetryEventQueue;
let optinRequested;
let cachedIp;

export function activate(context: ExtensionContext) {
	openTelemetryOptInDialog(context.extensionPath);
	enableJavadocSymbols();

	return requirements.resolveRequirements().catch(error => {
		//show error
		window.showErrorMessage(error.message, error.label).then((selection) => {
			if (error.label && error.label === selection && error.openUrl) {
				commands.executeCommand(Commands.OPEN_BROWSER, error.openUrl);
			}
		});
		// rethrow to disrupt the chain.
		throw error;
	}).then(requirements => {
		return window.withProgress({ location: ProgressLocation.Window }, p => {
			return new Promise((resolve, reject) => {
				let storagePath = context.storagePath;
				if (!storagePath) {
					storagePath = getTempWorkspace();
				}
				let workspacePath = path.resolve(storagePath + '/jdt_ws');

				// Options to control the language client
				let clientOptions: LanguageClientOptions = {
					// Register the server for java
					documentSelector: ['java'],
					synchronize: {
						configurationSection: 'java',
						// Notify the server about file changes to .java and project/build files contained in the workspace
						fileEvents: [
							workspace.createFileSystemWatcher('**/*.java'),
							workspace.createFileSystemWatcher('**/pom.xml'),
							workspace.createFileSystemWatcher('**/*.gradle'),
							workspace.createFileSystemWatcher('**/.project'),
							workspace.createFileSystemWatcher('**/.classpath'),
							workspace.createFileSystemWatcher('**/settings/*.prefs')
						],
					},
					initializationOptions: {
						bundles: collectionJavaExtensions(extensions.all)
					},
					revealOutputChannelOn: RevealOutputChannelOn.Never
				};

				let item = window.createStatusBarItem(StatusBarAlignment.Right, Number.MIN_VALUE);
				item.text = '$(rocket)';
				item.command = Commands.OPEN_OUTPUT;

				oldConfig = getJavaConfiguration();
				let serverOptions;
				let port = process.env['SERVER_PORT'];
				if (!port) {
					serverOptions = prepareExecutable(requirements, workspacePath, getJavaConfiguration());
				} else {
					// used during development
					serverOptions = awaitServerConnection.bind(null, port);
				}
				let writeKey = getSegmentWriteKey(context);
				if (writeKey) {
					analytics = new Analytics(writeKey, { flushAt: 1 });
					report(startupEvent());
				}
				// Create the language client and start the client.
				let languageClient = new LanguageClient('java', 'Language Support for Java', serverOptions, clientOptions);
				languageClient.onReady().then(() => {
					languageClient.onTelemetry(e => {
						if (analytics) {
							if (isTelemetryOptIn()) {
								report(e);
							} else if (telemetryEventQueue) {//waiting for optin response
								telemetryEventQueue.push(e);
							}
						}
					});
					languageClient.onNotification(StatusNotification.type, (report) => {
						switch (report.type) {
							case 'Started':
								item.text = '$(thumbsup)';
								p.report({ message: 'Finished' });
								lastStatus = item.text;
								resolve();
								break;
							case 'Error':
								item.text = '$(thumbsdown)';
								lastStatus = item.text;
								p.report({ message: 'Finished with Error' });
								item.tooltip = report.message;
								toggleItem(window.activeTextEditor, item);
								resolve();
								break;
							case 'Starting':
								p.report({ message: report.message });
								item.tooltip = report.message;
								break;
							case 'Message':
								item.text = report.message;
								setTimeout(() => { item.text = lastStatus; }, 3000);
								break;
						}
						item.tooltip = report.message;
						toggleItem(window.activeTextEditor, item);
					});
					languageClient.onNotification(ActionableNotification.type, (notification) => {
						let show = null;
						switch (notification.severity) {
							case MessageType.Log:
								show = logNotification;
								break;
							case MessageType.Info:
								show = window.showInformationMessage;
								break;
							case MessageType.Warning:
								show = window.showWarningMessage;
								break;
							case MessageType.Error:
								show = window.showErrorMessage;
								break;
						}
						if (!show) {
							return;
						}
						const titles = notification.commands.map(a => a.title);
						show(notification.message, ...titles).then((selection) => {
							for (let action of notification.commands) {
								if (action.title === selection) {
									let args: any[] = (action.arguments) ? action.arguments : [];
									commands.executeCommand(action.command, ...args);
									break;
								}
							}
						});
					});
					commands.registerCommand(Commands.OPEN_OUTPUT, () => {
						languageClient.outputChannel.show(ViewColumn.Three);
					});
					commands.registerCommand(Commands.SHOW_JAVA_REFERENCES, (uri: string, position: LSPosition, locations: LSLocation[]) => {
						commands.executeCommand(Commands.SHOW_REFERENCES, Uri.parse(uri), languageClient.protocol2CodeConverter.asPosition(position), locations.map(languageClient.protocol2CodeConverter.asLocation));
					});
					commands.registerCommand(Commands.SHOW_JAVA_IMPLEMENTATIONS, (uri: string, position: LSPosition, locations: LSLocation[]) => {
						commands.executeCommand(Commands.SHOW_REFERENCES, Uri.parse(uri), languageClient.protocol2CodeConverter.asPosition(position), locations.map(languageClient.protocol2CodeConverter.asLocation));
					});

					commands.registerCommand(Commands.CONFIGURATION_UPDATE, uri => projectConfigurationUpdate(languageClient, uri));

					commands.registerCommand(Commands.IGNORE_INCOMPLETE_CLASSPATH, (data?: any) => setIncompleteClasspathSeverity('ignore'));

					commands.registerCommand(Commands.IGNORE_INCOMPLETE_CLASSPATH_HELP, (data?: any) => {
						commands.executeCommand(Commands.OPEN_BROWSER, Uri.parse('https://github.com/redhat-developer/vscode-java/wiki/%22Classpath-is-incomplete%22-warning'))
					});

					commands.registerCommand(Commands.PROJECT_CONFIGURATION_STATUS, (uri, status) => setProjectConfigurationUpdate(languageClient, uri, status));

					commands.registerCommand(Commands.APPLY_WORKSPACE_EDIT, (obj) => {
						let edit = languageClient.protocol2CodeConverter.asWorkspaceEdit(obj);
						if (edit) {
							workspace.applyEdit(edit);
						}
					});

					commands.registerCommand(Commands.EXECUTE_WORKSPACE_COMMAND, (command, ...rest) => {
						const params: ExecuteCommandParams = {
							command,
							arguments: rest
						}
						return languageClient.sendRequest(ExecuteCommandRequest.type, params);
					});

					window.onDidChangeActiveTextEditor((editor) => {
						toggleItem(editor, item);
					});

					let provider: TextDocumentContentProvider = <TextDocumentContentProvider>{
						onDidChange: null,
						provideTextDocumentContent: (uri: Uri, token: CancellationToken): Thenable<string> => {
							return languageClient.sendRequest(ClassFileContentsRequest.type, { uri: uri.toString() }, token).then((v: string): string => {
								return v || '';
							});
						}
					};
					workspace.registerTextDocumentContentProvider('jdt', provider);
				});
				let disposable = languageClient.start();
				// Register commands here to make it available even when the language client fails
				commands.registerCommand(Commands.OPEN_SERVER_LOG, () => openServerLogFile(workspacePath));

				// Push the disposable to the context's subscriptions so that the
				// client can be deactivated on extension deactivation
				context.subscriptions.push(disposable);
				context.subscriptions.push(onConfigurationChange());
				toggleItem(window.activeTextEditor, item);
			});
		});
	});
}

function enableJavadocSymbols() {
	// Let's enable Javadoc symbols autocompletion, shamelessly copied from MIT licensed code at
	// https://github.com/Microsoft/vscode/blob/9d611d4dfd5a4a101b5201b8c9e21af97f06e7a7/extensions/typescript/src/typescriptMain.ts#L186
	languages.setLanguageConfiguration('java', {
		indentationRules: {
			// ^(.*\*/)?\s*\}.*$
			decreaseIndentPattern: /^(.*\*\/)?\s*\}.*$/,
			// ^.*\{[^}"']*$
			increaseIndentPattern: /^.*\{[^}"']*$/
		},
		wordPattern: /(-?\d*\.\d\w*)|([^\`\~\!\@\#\%\^\&\*\(\)\-\=\+\[\{\]\}\\\|\;\:\'\"\,\.\<\>\/\?\s]+)/g,
		onEnterRules: [
			{
				// e.g. /** | */
				beforeText: /^\s*\/\*\*(?!\/)([^\*]|\*(?!\/))*$/,
				afterText: /^\s*\*\/$/,
				action: { indentAction: IndentAction.IndentOutdent, appendText: ' * ' }
			},
			{
				// e.g. /** ...|
				beforeText: /^\s*\/\*\*(?!\/)([^\*]|\*(?!\/))*$/,
				action: { indentAction: IndentAction.None, appendText: ' * ' }
			},
			{
				// e.g.  * ...|
				beforeText: /^(\t|(\ \ ))*\ \*(\ ([^\*]|\*(?!\/))*)?$/,
				action: { indentAction: IndentAction.None, appendText: '* ' }
			},
			{
				// e.g.  */|
				beforeText: /^(\t|(\ \ ))*\ \*\/\s*$/,
				action: { indentAction: IndentAction.None, removeText: 1 }
			},
			{
				// e.g.  *-----*/|
				beforeText: /^(\t|(\ \ ))*\ \*[^/]*\*\/\s*$/,
				action: { indentAction: IndentAction.None, removeText: 1 }
			}
		]
	});
}

function logNotification(message: string, ...items: string[]) {
	return new Promise((resolve, reject) => {
		console.log(message);
	});
}

function setIncompleteClasspathSeverity(severity: string) {
	const config = getJavaConfiguration();
	const section = 'errors.incompleteClasspath.severity';
	config.update(section, severity, true).then(
		() => console.log(section + ' globally set to ' + severity),
		(error) => console.log(error)
	);
}

function setTelemetryOptIn(optin: boolean) {
	const config = getJavaConfiguration();
	const section = 'telemetry.enabled';
	config.update(section, optin, true).then(
		() => console.log(section + ' globally set to ' + optin),
		(error) => console.log(error)
	);
}


function isTelemetryOptIn(): boolean {
	return getJavaConfiguration().get('telemetry.enabled', false)
}

function projectConfigurationUpdate(languageClient: LanguageClient, uri?: Uri) {
	let resource = uri;
	if (!(resource instanceof Uri)) {
		if (window.activeTextEditor) {
			resource = window.activeTextEditor.document.uri;
		}
	}
	if (!resource) {
		return window.showWarningMessage('No Java project to update!').then(() => false);
	}
	if (isJavaConfigFile(resource.path)) {
		languageClient.sendNotification(ProjectConfigurationUpdateRequest.type, {
			uri: resource.toString()
		});
	}
}

function setProjectConfigurationUpdate(languageClient: LanguageClient, uri: Uri, status: FeatureStatus) {
	const config = getJavaConfiguration();
	const section = 'configuration.updateBuildConfiguration';

	const st = FeatureStatus[status];
	config.update(section, st).then(
		() => console.log(section + ' set to ' + st),
		(error) => console.log(error)
	);
	if (status !== FeatureStatus.disabled) {
		projectConfigurationUpdate(languageClient, uri);
	}
}
function toggleItem(editor: TextEditor, item) {
	if (editor && editor.document &&
		(editor.document.languageId === 'java' || isJavaConfigFile(editor.document.uri.path))) {
		item.show();
	} else {
		item.hide();
	}
}

function isJavaConfigFile(path: String) {
	return path.endsWith('pom.xml') || path.endsWith('.gradle');
}

function onConfigurationChange() {
	return workspace.onDidChangeConfiguration(params => {
		let newConfig = getJavaConfiguration();
		if (hasJavaConfigChanged(oldConfig, newConfig)) {
			let msg = 'Java Language Server configuration changed, please restart VS Code.';
			let action = 'Restart Now';
			let restartId = Commands.RELOAD_WINDOW;
			oldConfig = newConfig;
			window.showWarningMessage(msg, action).then((selection) => {
				if (action === selection) {
					commands.executeCommand(restartId);
				}
			});
		}
	});
}

function hasJavaConfigChanged(oldConfig, newConfig) {
	return hasConfigKeyChanged('home', oldConfig, newConfig)
		|| hasConfigKeyChanged('jdt.ls.vmargs', oldConfig, newConfig);
}

function hasConfigKeyChanged(key, oldConfig, newConfig) {
	return oldConfig.get(key) !== newConfig.get(key);
}


function getTempWorkspace() {
	return path.resolve(os.tmpdir(), 'vscodesws_' + makeRandomHexString(5));
}

function makeRandomHexString(length) {
	let chars = ['0', '1', '2', '3', '4', '5', '6', '6', '7', '8', '9', 'a', 'b', 'c', 'd', 'e', 'f'];
	let result = '';
	for (let i = 0; i < length; i++) {
		let idx = Math.floor(chars.length * Math.random());
		result += chars[idx];
	}
	return result;
}

function getJavaConfiguration(): WorkspaceConfiguration {
	return workspace.getConfiguration('java');
}

function openServerLogFile(workspacePath): Thenable<boolean> {
	let serverLogFile = path.join(workspacePath, '.metadata', '.log');
	if (!serverLogFile) {
		return window.showWarningMessage('Java Language Server has not started logging.').then(() => false);
	}

	return workspace.openTextDocument(serverLogFile)
		.then(doc => {
			if (!doc) {
				return false;
			}
			return window.showTextDocument(doc, window.activeTextEditor ?
				window.activeTextEditor.viewColumn : undefined)
				.then(editor => !!editor);
		}, () => false)
		.then(didOpen => {
			if (!didOpen) {
				window.showWarningMessage('Could not open Java Language Server log file');
			}
			return didOpen;
		});
}

function openTelemetryOptInDialog(extensionPath) {
	//check if user has already been asked to opt-in.
	//He will be asked every time a new extension is installed
	let optinFile = path.resolve(extensionPath, 'optinrequested');
	optinRequested = pathExists.sync(optinFile);
	if (!optinRequested) {
		telemetryEventQueue = [];//create event queue until user makes a decision
		window.showInformationMessage('Java extension would like to report some usage data', 'More Information', 'Accept', 'Deny').then((selection) => {
			if (selection === 'undefined') {
				//close was chosen. Ask next time.
				return;
			}
			if (selection === 'More Information') {
				//open wiki page
				openWebPage('https://github.com/redhat-developer/vscode-java/wiki/Usage-reporting');
				//reopen dialog immediately
				openTelemetryOptInDialog(extensionPath);
				return;
			}
			const optIn = selection === 'Accept';
			setTelemetryOptIn(optIn);//store decision in global preferences
			fs.open(optinFile, 'w', (err, fd) => {
				if (fd) {
					fs.close(fd);
				}
			});
			if (optIn && telemetryEventQueue) {
				//report all events that were waiting for opt-in
				telemetryEventQueue.forEach(e => {
					report(e);
				});
				//discard queue
				telemetryEventQueue = null;
			}
		});
	}
}
function report(e) {
	if (analytics) {
		console.log('Tracking '+e.name);
		getIp().then(ip => {
			analytics.track({
				anonymousId: env.machineId || 'vscode.developer',
				event: e.name,
				//timestamp: (e.timestamp)?new Date(e.timestamp).t:null,
				properties: (e.properties) ? e.properties : e.measures,
				context: { ip: ip }
			}, function (err, batch) {
				if (err) {// There was an error flushing data...
					console.log(err);
				} else if (batch) {
					console.log(batch);
				}
			});
		});
	}
}

function startupEvent() {
	return {
		name: 'vscode.java.startup',
		properties: {
			version: '0.13.0',
			vscode: version,
			os:os.platform(),
			extensions: collectJavaExtensionContributors(extensions.all)
		}
	}
}

function getIp():Thenable<string> {
	if (cachedIp) {
		return new Promise((resolve, reject) => {
			resolve(cachedIp);
		});
	}
	return publicIp.v4({https:true}).then(publicIp => {
		console.log('Public IP address is '+publicIp);
		cachedIp = publicIp;
		return new Promise((resolve, reject) => {
			resolve(cachedIp);
		})
		.catch(err => {
			return new Promise((resolve, reject) => {
				console.log('Failed to determine public IP: '+err.message);
				resolve('127.0.0.1');
			});
		})
	});
}

function getSegmentWriteKey(context: ExtensionContext): String {
	let extensionPackage = require(context.asAbsolutePath('./package.json'));
	if (extensionPackage) {
		return extensionPackage.segmentWriteKey
	}
	return null;
}

function openWebPage(url: string) {
	commands.executeCommand(Commands.OPEN_BROWSER, Uri.parse(url));
}

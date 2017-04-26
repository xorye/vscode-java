'use strict';

import { Extension } from 'vscode';
import * as path from 'path';

interface IPackageInfo {
	publisher:string;
	name: string;
	version: string;
}

export function collectionJavaExtensions(extensions: Extension<any>[]): string[] {
	let result = [];
	if (extensions && extensions.length) {
		for (let extension of extensions) {
			let contributesSection = extension.packageJSON['contributes'];
			if (contributesSection) {
				let javaExtensions = contributesSection['javaExtensions'];
				if (Array.isArray(javaExtensions) && javaExtensions.length) {
					for (let javaExtensionPath of javaExtensions) {
						result.push(path.resolve(extension.extensionPath, javaExtensionPath));
					}
				}
			}
		}
	}
	return result;
}

export function collectJavaExtensionContributors(extensions: Extension<any>[]): IPackageInfo[] {
	let result = [];
	if (extensions && extensions.length) {
		for (let extension of extensions) {
			let contributesSection = extension.packageJSON['contributes'];
			if (contributesSection) {
				let javaExtensions = contributesSection['javaExtensions'];
				if (Array.isArray(javaExtensions) && javaExtensions.length) {
					result.push({
						name: extension.packageJSON['name'],
						publisher: extension.packageJSON['publisher'],
						version: extension.packageJSON['version']
					});
				}
			}
		}
	}
	return result;
}


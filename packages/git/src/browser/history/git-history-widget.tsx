/********************************************************************************
 * Copyright (C) 2018 TypeFox and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License v. 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0.
 *
 * This Source Code may also be made available under the following Secondary
 * Licenses when the conditions for such availability set forth in the Eclipse
 * Public License v. 2.0 are satisfied: GNU General Public License, version 2
 * with the GNU Classpath Exception which is available at
 * https://www.gnu.org/software/classpath/license.html.
 *
 * SPDX-License-Identifier: EPL-2.0 OR GPL-2.0 WITH Classpath-exception-2.0
 ********************************************************************************/

import { injectable, inject } from 'inversify';
import { DiffUris } from '@theia/core/lib/browser/diff-uris';
import { OpenerService, open, StatefulWidget, SELECTED_CLASS, WidgetManager, ApplicationShell } from '@theia/core/lib/browser';
import { GIT_RESOURCE_SCHEME } from '../git-resource';
import URI from '@theia/core/lib/common/uri';
import { CancellationTokenSource } from '@theia/core/lib/common/cancellation';
import { GIT_HISTORY } from './git-history-contribution';
import { GitFileStatus, Git, GitFileChange } from '../../common';
import { FileSystem } from '@theia/filesystem/lib/common';
import { GitDiffContribution } from '../diff/git-diff-contribution';
import { GitAvatarService } from './git-avatar-service';
import { GitCommitDetailUri, GitCommitDetailOpenerOptions, GitCommitDetailOpenHandler } from './git-commit-detail-open-handler';
import { GitCommitDetails } from './git-commit-detail-widget';
import { GitNavigableListWidget } from '../git-navigable-list-widget';
import { GitFileChangeNode } from '../git-widget';
import * as React from 'react';
import { AutoSizer, List, ListRowRenderer, ListRowProps } from 'react-virtualized';

export interface GitCommitNode extends GitCommitDetails {
    fileChanges?: GitFileChange[];
    expanded: boolean;
    selected: boolean;
}

export namespace GitCommitNode {
    export function is(node: any): node is GitCommitNode {
        return 'commitSha' in node && 'commitMessage' in node && 'fileChangeNodes' in node;
    }
}

export type GitHistoryListNode = (GitCommitNode | GitFileChangeNode);

@injectable()
export class GitHistoryWidget extends GitNavigableListWidget<GitHistoryListNode> implements StatefulWidget {
    protected options: Git.Options.Log;
    protected commits: GitCommitNode[];
    protected ready: boolean;
    protected singleFileMode: boolean;
    private cancelIndicator = new CancellationTokenSource();
    protected listView: GitHistoryList | undefined;

    constructor(
        @inject(OpenerService) protected readonly openerService: OpenerService,
        @inject(GitCommitDetailOpenHandler) protected readonly detailOpenHandler: GitCommitDetailOpenHandler,
        @inject(ApplicationShell) protected readonly shell: ApplicationShell,
        @inject(FileSystem) protected readonly fileSystem: FileSystem,
        @inject(Git) protected readonly git: Git,
        @inject(GitAvatarService) protected readonly avartarService: GitAvatarService,
        @inject(WidgetManager) protected readonly widgetManager: WidgetManager,
        @inject(GitDiffContribution) protected readonly diffContribution: GitDiffContribution) {
        super();
        this.id = GIT_HISTORY;
        this.scrollContainer = 'git-history-list-container';
        this.title.label = 'Git History';
        this.addClass('theia-git');
        this.options = {};
        this.commits = [];
        this.gitNodes = [];
        this.scrollOptions = undefined;
    }

    update() {
        if (this.listView && this.listView.list) {
            this.listView.list.forceUpdateGrid();
        }
        super.update();
    }

    async setContent(options?: Git.Options.Log) {
        this.options = options || {};
        this.commits = [];
        this.gitNodes = [];
        this.ready = false;
        if (options && options.uri) {
            const fileStat = await this.fileSystem.getFileStat(options.uri);
            this.singleFileMode = !!fileStat && !fileStat.isDirectory;
        }
        this.addCommits(options);
        // this.update();
    }

    protected addCommits(options?: Git.Options.Log) {
        const repository = this.repositoryProvider.selectedRepository;
        this.cancelIndicator.cancel();
        this.cancelIndicator = new CancellationTokenSource();
        const token = this.cancelIndicator.token;
        if (repository) {
            const log = this.git.log(repository, options);
            log.then(async changes => {
                if (token.isCancellationRequested) {
                    return;
                }
                if (this.commits.length > 0) {
                    changes = changes.slice(1);
                }
                if (changes.length > 0) {
                    const commits: GitCommitNode[] = [];
                    for (const commit of changes) {
                        const fileChangeNodes: GitFileChangeNode[] = [];
                        const avatarUrl = await this.avartarService.getAvatar(commit.author.email);
                        commits.push({
                            authorName: commit.author.name,
                            authorDate: new Date(commit.author.timestamp),
                            authorEmail: commit.author.email,
                            authorDateRelative: commit.authorDateRelative,
                            authorAvatar: avatarUrl,
                            commitSha: commit.sha,
                            commitMessage: commit.summary,
                            messageBody: commit.body,
                            fileChangeNodes,
                            fileChanges: commit.fileChanges,
                            expanded: false,
                            selected: false
                        });
                    }
                    this.commits.push(...commits);
                }
                this.onDataReady();
            });
        } else {
            this.commits = [];
            this.onDataReady();
        }
    }

    protected async addOrRemoveFileChangeNodes(commit: GitCommitNode) {
        const id = this.gitNodes.findIndex(node => node === commit);
        if (commit.fileChanges) {
            if (commit.expanded) {
                commit.expanded = false;
                this.gitNodes.splice(id + 1, commit.fileChanges.length);
            } else {
                const fileChangeNodes: GitFileChangeNode[] = [];
                await Promise.all(commit.fileChanges.map(async fileChange => {
                    const fileChangeUri = new URI(fileChange.uri);
                    const icon = await this.labelProvider.getIcon(fileChangeUri);
                    const label = this.labelProvider.getName(fileChangeUri);
                    const description = this.relativePath(fileChangeUri.parent);
                    const caption = this.computeCaption(fileChange);
                    fileChangeNodes.push({
                        ...fileChange, icon, label, description, caption, commitSha: commit.commitSha
                    });
                }));
                commit.expanded = true;
                this.gitNodes.splice(id + 1, 0, ...fileChangeNodes);
                // delete commit.fileChanges;
            }
            this.update();
        }
    }
    
    storeState(): object {
        const { commits, options, singleFileMode } = this;
        return {
            commits,
            options,
            singleFileMode
        };
    }

    // tslint:disable-next-line:no-any
    restoreState(oldState: any): void {
        this.commits = oldState['commits'];
        this.gitNodes = this.commits;
        this.options = oldState['options'];
        this.singleFileMode = oldState['singleFileMode'];
        this.ready = true;
        this.update();
    }

    protected onDataReady(): void {
        this.ready = true;
        this.gitNodes = this.commits;
        this.update();
    }

    protected render(): React.ReactNode {
        return <div className='git-diff-container'>
            {
                this.ready ?
                    < React.Fragment >
                        {this.renderHistoryHeader()}
                        {this.renderCommitList()}
                    </React.Fragment>
                    :
                    <div className='spinnerContainer'>
                        <span className='fa fa-spinner fa-pulse fa-3x fa-fw'></span>
                    </div>
            }
        </div>;
    }

    protected renderHistoryHeader(): React.ReactNode {
        if (this.options.uri) {
            const path = this.relativePath(this.options.uri);
            return <div className='diff-header'>
                {
                    path.length > 0 ?
                        <div className='header-row'>
                            <div className='theia-header'>
                                path:
                                </div>
                            <div className='header-value'>
                                {'/' + path}
                            </div>
                        </div>
                        : ''
                }
                <div className='theia-header'>
                    Commits
                </div>
            </div>;
        }
    }

    protected renderCommitList(): React.ReactNode {
        return <div className='listContainer' id={this.scrollContainer}>
            <GitHistoryList
                ref={listView => this.listView = (listView || undefined)}
                rows={this.gitNodes}
                indexOfSelected={this.indexOfSelected}
                renderCommit={this.renderCommit}
                renderFileChangeList={this.renderFileChangeList}
            ></GitHistoryList>
        </div>;
    }

    protected readonly renderCommit = (commit: GitCommitNode) => this.doRenderCommit(commit);
    protected doRenderCommit(commit: GitCommitNode): React.ReactNode {
        let expansionToggleIcon = 'caret-right';
        if (commit && commit.expanded) {
            expansionToggleIcon = 'caret-down';
        }
        return <div
            className={`containerHead${commit.selected ? ' ' + SELECTED_CLASS : ''}`}
            onClick={
                e => {
                    if (commit.selected && !this.singleFileMode) {
                        this.addOrRemoveFileChangeNodes(commit);
                        this.update();
                    } else {
                        this.selectNode(commit);
                    }
                    e.preventDefault();
                }
            }
            onDoubleClick={
                e => {
                    if (this.singleFileMode && commit.fileChanges && commit.fileChanges.length > 0) {
                        this.openFile(commit.fileChanges[0], commit.commitSha);
                    }
                    e.preventDefault();
                }
            }>
            <div className='headContent'><div className='image-container'>
                <img className='gravatar' src={commit.authorAvatar}></img>
            </div>
                <div className={`headLabelContainer${this.singleFileMode ? ' singleFileMode' : ''}`}>
                    <div className='headLabel noWrapInfo noselect'>
                        {commit.commitMessage}
                    </div>
                    <div className='commitTime noWrapInfo noselect'>
                        {commit.authorDateRelative + ' by ' + commit.authorName}
                    </div>
                </div>
                <div className='fa fa-eye detailButton' onClick={() => this.openDetailWidget(commit)}></div>
                {
                    !this.singleFileMode ? <div className='expansionToggle noselect'>
                        <div className='toggle'>
                            <div className='number'>{(commit.fileChanges && commit.fileChanges.length || commit.fileChangeNodes.length).toString()}</div>
                            <div className={'icon fa fa-' + expansionToggleIcon}></div>
                        </div>
                    </div>
                        : ''
                }
            </div>
        </div >;
    }

    protected readonly renderFileChangeList = (fileChange: GitFileChangeNode) => this.doRenderFileChangeList(fileChange);
    protected doRenderFileChangeList(fileChange: GitFileChangeNode): React.ReactNode {
        const fileChangeElement: React.ReactNode = this.renderGitItem(fileChange, fileChange.commitSha || '');
        return fileChangeElement;
    }

    protected async openDetailWidget(commit: GitCommitNode) {
        const commitDetails = this.detailOpenHandler.getCommitDetailWidgetOptions(commit);
        this.detailOpenHandler.open(GitCommitDetailUri.toUri(commit.commitSha), {
            ...commitDetails
        } as GitCommitDetailOpenerOptions);
    }

    protected renderGitItem(change: GitFileChangeNode, commitSha: string): React.ReactNode {
        return <div key={change.uri.toString()} className={`gitItem noselect${change.selected ? ' ' + SELECTED_CLASS : ''}`}>
            <div
                title={change.caption}
                className='noWrapInfo'
                onDoubleClick={() => {
                    this.openFile(change, commitSha);
                }}
                onClick={() => {
                    this.selectNode(change);
                }}>
                <span className={change.icon + ' file-icon'}></span>
                <span className='name'>{change.label + ' '}</span>
                <span className='path'>{change.description}</span>
            </div>
            {
                change.extraIconClassName ? <div
                    title={change.caption}
                    className={change.extraIconClassName}></div>
                    : ''
            }
            <div
                title={change.caption}
                className={'status staged ' + GitFileStatus[change.status].toLowerCase()}>
                {this.getStatusCaption(change.status, true).charAt(0)}
            </div>
        </div>;
    }

    protected navigateLeft(): void {
        const selected = this.getSelected();
        if (selected) {
            const idx = this.commits.findIndex(c => c.commitSha === selected.commitSha);
            if (GitCommitNode.is(selected)) {
                if (selected.expanded) {
                    this.addOrRemoveFileChangeNodes(selected);
                } else {
                    if (idx > 0) {
                        this.selectNode(this.commits[idx - 1]);
                    }
                }
            } else if (GitFileChangeNode.is(selected)) {
                this.selectNode(this.commits[idx]);
            }
        }
        this.update();
    }

    protected navigateRight(): void {
        const selected = this.getSelected();
        if (selected) {
            if (GitCommitNode.is(selected) && !selected.expanded && !this.singleFileMode) {
                this.addOrRemoveFileChangeNodes(selected);
            } else {
                this.selectNextNode();
            }
        }
        this.update();
    }

    protected handleListEnter(): void {
        const selected = this.getSelected();
        if (selected) {
            if (GitCommitNode.is(selected)) {
                if (this.singleFileMode) {
                    this.openFile(selected.fileChangeNodes[0], selected.commitSha);
                } else {
                    this.openDetailWidget(selected);
                }
            } else if (GitFileChangeNode.is(selected)) {
                this.openFile(selected, selected.commitSha || '');
            }
        }
        this.update();
    }

    protected openFile(change: GitFileChange, commitSha: string) {
        const uri: URI = new URI(change.uri);
        let fromURI = change.oldUri ? new URI(change.oldUri) : uri; // set oldUri on renamed and copied
        fromURI = fromURI.withScheme(GIT_RESOURCE_SCHEME).withQuery(commitSha + '~1');
        const toURI = uri.withScheme(GIT_RESOURCE_SCHEME).withQuery(commitSha);
        let uriToOpen = uri;
        if (change.status === GitFileStatus.Deleted) {
            uriToOpen = fromURI;
        } else if (change.status === GitFileStatus.New) {
            uriToOpen = toURI;
        } else {
            uriToOpen = DiffUris.encode(fromURI, toURI, uri.displayName);
        }
        open(this.openerService, uriToOpen, { mode: 'reveal' });
    }
}

export interface GitHistoryListProps {
    rows: GitHistoryListNode[]
    indexOfSelected: number
    renderCommit: (commit: GitCommitNode) => React.ReactNode
    renderFileChangeList: (fileChange: GitFileChangeNode) => React.ReactNode
}
export class GitHistoryList extends React.Component<GitHistoryListProps> {
    list: List | undefined;
    render(): React.ReactNode {
        console.log(this.props);
        return <AutoSizer>
            {
                ({ width, height }) => <List
                    className='commitList'
                    ref={list => this.list = (list || undefined)}
                    width={width}
                    height={height}
                    rowRenderer={this.renderRow}
                    rowCount={this.props.rows.length}
                    rowHeight={this.calcRowHeight}
                    tabIndex={-1}
                    scrollToIndex={this.props.indexOfSelected}
                />
            }
        </AutoSizer>;
    }

    componentDidUpdate() {
        if (this.list) {
            this.list.recomputeRowHeights(this.props.indexOfSelected);
        }
    }

    protected renderRow: ListRowRenderer = ({ index, key, style }) => {
        const row = this.props.rows[index];
        if (GitCommitNode.is(row)) {
            const head = this.props.renderCommit(row);
            return <div key={key} style={style} className='commitListElement'>
                {head}
            </div>;
        } else if (GitFileChangeNode.is(row)) {
            return <div key={key} style={style} className='fileChangeListElement'>
                {this.props.renderFileChangeList(row)}
            </div>;
        }
    }

    protected readonly calcRowHeight = (options: ListRowProps) => {
        const row = this.props.rows[options.index];
        if (GitFileChangeNode.is(row)) {
            return 21;
        }
        return 45;
    }
}

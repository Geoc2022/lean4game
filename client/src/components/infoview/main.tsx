/* Partly copied from https://github.com/leanprover/vscode-lean4/blob/master/lean4-infoview/src/infoview/main.tsx */

import * as React from 'react';
import type { DidCloseTextDocumentParams, DidChangeTextDocumentParams, Location, DocumentUri } from 'vscode-languageserver-protocol';

import 'tachyons/css/tachyons.css';
import '@vscode/codicons/dist/codicon.css';
import '../../../../node_modules/lean4-infoview/src/infoview/index.css';
import './infoview.css'

import { LeanFileProgressParams, LeanFileProgressProcessingInfo, defaultInfoviewConfig, EditorApi, InfoviewApi } from '@leanprover/infoview-api';
import { useClientNotificationEffect, useServerNotificationEffect, useEventResult, useServerNotificationState } from '../../../../node_modules/lean4-infoview/src/infoview/util';
import { EditorContext, ConfigContext, ProgressContext, VersionContext } from '../../../../node_modules/lean4-infoview/src/infoview/contexts';
import { WithRpcSessions } from '../../../../node_modules/lean4-infoview/src/infoview/rpcSessions';
import { ServerVersion } from '../../../../node_modules/lean4-infoview/src/infoview/serverVersion';

import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faDeleteLeft, faHome, faArrowRight, faArrowLeft, faRotateLeft } from '@fortawesome/free-solid-svg-icons'
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'

import { GameIdContext } from '../../app';
import { useAppDispatch, useAppSelector } from '../../hooks';
import { LevelInfo } from '../../state/api';
import { levelCompleted, selectCompleted } from '../../state/progress';
import Markdown from '../markdown';

import { Infos } from './infos';
import { AllMessages, Errors, WithLspDiagnosticsContext } from './messages';
import { Goal } from './goals';
import { InputModeContext, MonacoEditorContext, ProofContext, ProofStep, SelectionContext } from './context';
import { CommandLine, hasErrors, hasInteractiveErrors } from './command_line';
import { InteractiveDiagnostic } from '@leanprover/infoview/*';
import { Button } from '../button';
import { CircularProgress } from '@mui/material';

/** Wrapper for the two editors. It is important that the `div` with `codeViewRef` is
 * always present, or the monaco editor cannot start.
 */
export function DualEditor({level, codeviewRef, levelId, worldId}) {
  const ec = React.useContext(EditorContext)
  const {commandLineMode} = React.useContext(InputModeContext)
  return <>
    <div className={commandLineMode ? 'hidden' : ''}>
      <ExerciseStatement data={level?.data} />
      <div ref={codeviewRef} className={'codeview'}></div>
    </div>
    {ec ?
      <DualEditorMain worldId={worldId} levelId={levelId} level={level} /> :
      // TODO: Style this if relevant.
      <>
        <p>Editor is starting up...</p>
        <CircularProgress />
      </>
    }
  </>
}

/** The part of the two editors that needs the editor connection first */
function DualEditorMain({worldId, levelId, level}) {
  const ec = React.useContext(EditorContext)
  const gameId = React.useContext(GameIdContext)
  const {commandLineMode} = React.useContext(InputModeContext)

  /* Set up updates to the global infoview state on editor events. */
  const config = useEventResult(ec.events.changedInfoviewConfig) ?? defaultInfoviewConfig;

  const [allProgress, _1] = useServerNotificationState(
    '$/lean/fileProgress',
    new Map<DocumentUri, LeanFileProgressProcessingInfo[]>(),
    async (params: LeanFileProgressParams) => (allProgress) => {
      const newProgress = new Map(allProgress);
      return newProgress.set(params.textDocument.uri, params.processing);
    }, [])
  const serverVersion = useEventResult(ec.events.serverRestarted, result => new ServerVersion(result.serverInfo?.version ?? ''))

  return <>
  <ConfigContext.Provider value={config}>
    <VersionContext.Provider value={serverVersion}>
      <WithRpcSessions>
        <WithLspDiagnosticsContext>
          <ProgressContext.Provider value={allProgress}>
            {commandLineMode ?
              <CommandLineInterface world={worldId} level={levelId} data={level?.data}/>
              :
              <Main key={`${worldId}/${levelId}`} world={worldId} level={levelId} />
            }
          </ProgressContext.Provider>
        </WithLspDiagnosticsContext>
      </WithRpcSessions>
    </VersionContext.Provider>
  </ConfigContext.Provider>
</>
}

/** The mathematical formulation of the statement, supporting e.g. Latex
 * It takes three forms, depending on the precence of name and description:
 * - Theorem xyz: description
 * - Theorem xyz
 * - Exercises: description
 */
function ExerciseStatement({data}) {
  if (!data?.descrText) { return <></> }
  return <div className="exercise-statement"><Markdown>
    {(data?.statementName ? `**Theorem** \`${data?.statementName}\`: ` : data?.descrText && "**Exercise**: ") + `${data?.descrText}` }
  </Markdown></div>
}

// TODO: This is only used in `EditorInterface`
// while `CommandLineInterface` has this copy-pasted in.
export function Main(props: {world: string, level: number}) {
    const ec = React.useContext(EditorContext);
    const gameId = React.useContext(GameIdContext)

    const dispatch = useAppDispatch()

    // Mark level as completed when server gives notification
    useServerNotificationEffect(
        '$/game/completed',
        (params: any) => {

            if (ec.events.changedCursorLocation.current &&
                ec.events.changedCursorLocation.current.uri === params.uri) {
                dispatch(levelCompleted({game: gameId, world: props.world, level: props.level}))
            }
        },
        []
    );

    const completed = useAppSelector(selectCompleted(gameId, props.world, props.level))

    /* Set up updates to the global infoview state on editor events. */
    const config = useEventResult(ec.events.changedInfoviewConfig) ?? defaultInfoviewConfig;

    const [allProgress, _1] = useServerNotificationState(
        '$/lean/fileProgress',
        new Map<DocumentUri, LeanFileProgressProcessingInfo[]>(),
        async (params: LeanFileProgressParams) => (allProgress) => {
            const newProgress = new Map(allProgress);
            return newProgress.set(params.textDocument.uri, params.processing);
        },
        []
    );

    const curUri = useEventResult(ec.events.changedCursorLocation, loc => loc?.uri);

    useClientNotificationEffect(
        'textDocument/didClose',
        (params: DidCloseTextDocumentParams) => {
            if (ec.events.changedCursorLocation.current &&
                ec.events.changedCursorLocation.current.uri === params.textDocument.uri) {
                ec.events.changedCursorLocation.fire(undefined)
            }
        },
        []
    );

    const serverVersion =
        useEventResult(ec.events.serverRestarted, result => new ServerVersion(result.serverInfo?.version ?? ''))
    const serverStoppedResult = useEventResult(ec.events.serverStopped);
    // NB: the cursor may temporarily become `undefined` when a file is closed. In this case
    // it's important not to reconstruct the `WithBlah` wrappers below since they contain state
    // that we want to persist.
    let ret
    if (!serverVersion) {
        ret = <p>Waiting for Lean server to start...</p>
    } else if (serverStoppedResult){
        ret = <div><p>{serverStoppedResult.message}</p><p className="error">{serverStoppedResult.reason}</p></div>
    } else {
        ret = <div className="infoview vscode-light">
            {completed && <div className="level-completed">Level completed! 🎉</div>}
            <Infos />
        </div>
    }

    return ret
}

const goalFilter = {
  reverse: false,
  showType: true,
  showInstance: true,
  showHiddenAssumption: true,
  showLetValue: true
}

/** The display of a single entered lean command */
function Command({command, deleteProof} : {command: string, deleteProof: any}) {
  // The first step will always have an empty command
  if (!command) {return <></>}
  return <div className="command">
    {command}
    <div className="undo-button" title="Delete this and future commands" onClick={deleteProof}>
      <FontAwesomeIcon icon={faDeleteLeft} />
    </div>
  </div>
}

// const MessageView = React.memo(({uri, diag}: MessageViewProps) => {
//   const ec = React.useContext(EditorContext);
//   const fname = escapeHtml(basename(uri));
//   const {line, character} = diag.range.start;
//   const loc: Location = { uri, range: diag.range };
//   const text = TaggedText_stripTags(diag.message);
//   const severityClass = diag.severity ? {
//       [DiagnosticSeverity.Error]: 'error',
//       [DiagnosticSeverity.Warning]: 'warning',
//       [DiagnosticSeverity.Information]: 'information',
//       [DiagnosticSeverity.Hint]: 'hint',
//   }[diag.severity] : '';
//   const title = `Line ${line+1}, Character ${character}`;

//   // Hide "unsolved goals" messages
//   let message;
//   if ("append" in diag.message && "text" in diag.message.append[0] &&
//     diag.message?.append[0].text === "unsolved goals") {
//       message = diag.message.append[0]
//   } else {
//       message = diag.message
//   }

//   const { commandLineMode } = React.useContext(InputModeContext)

//   return (
//   // <details open>
//       // <summary className={severityClass + ' mv2 pointer'}>{title}
//       //     <span className="fr">
//       //         <a className="link pointer mh2 dim codicon codicon-go-to-file"
//       //            onClick={e => { e.preventDefault(); void ec.revealLocation(loc); }}
//       //            title="reveal file location"></a>
//       //         <a className="link pointer mh2 dim codicon codicon-quote"
//       //            data-id="copy-to-comment"
//       //            onClick={e => {e.preventDefault(); void ec.copyToComment(text)}}
//       //            title="copy message to comment"></a>
//       //         <a className="link pointer mh2 dim codicon codicon-clippy"
//       //            onClick={e => {e.preventDefault(); void ec.api.copyToClipboard(text)}}
//       //            title="copy message to clipboard"></a>
//       //     </span>
//       // </summary>
//       <div className={severityClass + ' ml1 message'}>
//           {!commandLineMode && <p className="mv2">{title}</p>}
//           <pre className="font-code pre-wrap">
//               <InteractiveMessage fmt={message} />
//           </pre>
//       </div>
//   // </details>
//   )
// }, fastIsEqual)

/** The tabs of goals that lean ahs after the command of this step has been processed */
function GoalsTab({proofStep} : {proofStep: ProofStep}) {
  const [selectedGoal, setSelectedGoal] = React.useState<number>(0)

  if (!proofStep.goals.length) {return <></>}

  return <div>
    <div className="tab-bar">
      {proofStep.goals.map((goal, i) => (
        <div className={`tab ${i == (selectedGoal) ? "active": ""}`} onClick={(ev) => { setSelectedGoal(i); ev.stopPropagation() }}>
          {i ? `Goal ${i+1}` : "Active Goal"}
        </div>
      ))}
    </div>
    <div className="goal-tab vscode-light">
      <Goal commandLine={false} filter={goalFilter} goal={proofStep.goals[selectedGoal]} />
    </div>
  </div>
}

/** The interface in command line mode */
export function CommandLineInterface(props: {world: string, level: number, data: LevelInfo}) {

  const ec = React.useContext(EditorContext)
  const editor = React.useContext(MonacoEditorContext)
  const gameId = React.useContext(GameIdContext)
  const {proof} = React.useContext(ProofContext)
  const {selectedStep, setSelectedStep} = React.useContext(SelectionContext)

  const proofPanelRef = React.useRef<HTMLDivElement>(null)

  const dispatch = useAppDispatch()

  // Mark level as completed when server gives notification
  useServerNotificationEffect(
    '$/game/completed',
    (params: any) => {

      if (ec.events.changedCursorLocation.current &&
          ec.events.changedCursorLocation.current.uri === params.uri) {
          dispatch(levelCompleted({game: gameId, world: props.world, level: props.level}))
      }
    }, []
  )

  // React.useEffect(() => {
  //   console.debug('updated proof')
  //   // proofPanelRef.current?.lastElementChild?.scrollIntoView() //scrollTo(0,0)
  // }, [proof])

  /** Delete all proof lines starting from a given line.
   * Note that the first line (i.e. deleting everything) is `1`!
   */
  function deleteProof(line: number) {
    return (ev) => {
      editor.executeEdits("command-line", [{
        range: monaco.Selection.fromPositions(
          {lineNumber: line, column: 1},
          editor.getModel().getFullModelRange().getEndPosition()
        ),
        text: '',
        forceMoveMarkers: false
      }])
      setSelectedStep(undefined)
      ev.stopPropagation()
    }
  }

  function toggleSelectStep(line: number) {
    return (ev) => {
      if (selectedStep == line) {
        setSelectedStep(undefined)
        console.debug(`unselected step`)
      } else {
        setSelectedStep(line)
        console.debug(`step ${line} selected`)
      }
    }
  }

  // Scroll to element if selection changes
  React.useEffect(() => {
    if (selectedStep) {
      Array.from(proofPanelRef.current?.getElementsByClassName(`step-${selectedStep}`)).map((elem) => {
        elem.scrollIntoView({block: "center"})
      })
    }
  }, [selectedStep])


  const completed = useAppSelector(selectCompleted(gameId, props.world, props.level))

  /* Set up updates to the global infoview seither you solved the level with warnings or your last command contains a syntax error Lean can't parseate on editor events. */
  const config = useEventResult(ec.events.changedInfoviewConfig) ?? defaultInfoviewConfig;

  const [allProgress, _1] = useServerNotificationState(
    '$/lean/fileProgress',
    new Map<DocumentUri, LeanFileProgressProcessingInfo[]>(),
    async (params: LeanFileProgressParams) => (allProgress) => {
      const newProgress = new Map(allProgress);
      return newProgress.set(params.textDocument.uri, params.processing);
    }, []
  )

  const curUri = useEventResult(ec.events.changedCursorLocation, loc => loc?.uri);

  useClientNotificationEffect(
    'textDocument/didClose',
    (params: DidCloseTextDocumentParams) => {
      if (ec.events.changedCursorLocation.current &&
        ec.events.changedCursorLocation.current.uri === params.textDocument.uri) {
        ec.events.changedCursorLocation.fire(undefined)
      }
    }, []
  )

  const serverVersion =
      useEventResult(ec.events.serverRestarted, result => new ServerVersion(result.serverInfo?.version ?? ''))
  const serverStoppedResult = useEventResult(ec.events.serverStopped);
  // NB: the cursor may temporarily become `undefined` when a file is closed. In this case
  // it's important not to reconstruct the `WithBlah` wrappers below since they contain state
  // that we want to persist.

  if (!serverVersion) {return <p>Waiting for Lean server to start...</p>}
  if (serverStoppedResult) {return <div>
    <p>{serverStoppedResult.message}</p>
    <p className="error">{serverStoppedResult.reason}</p>
  </div>}

  return <div className="commandline-interface">
    <div className="content" ref={proofPanelRef}>
      <ExerciseStatement data={props.data} />
      <div className="tmp-pusher"></div>
      {proof.length ? proof.map((step, i) => {
        if (i == proof.length - 1 && hasInteractiveErrors(step.errors)) {
          // if the last command contains an error, we only display the errors but not the
          // entered command as it is still present in the command line.
          return <div>
            <Errors errors={step.errors} commandLineMode={true}/>
          </div>
        } else {
          return <>
            <div className={`step step-${i}` + (selectedStep == i ? ' selected' : '')} onClick={toggleSelectStep(i)}>
              <Command command={step.command} deleteProof={deleteProof(i)}/>
              <Errors errors={step.errors} commandLineMode={true}/>
              <GoalsTab proofStep={step}/>
            </div>
            {/* Show a message that there are no goals left */}
            {!step.goals.length && (
              <div className="message information">
                {completed ?
                  <p>Level completed! 🎉</p> :
                  <p>
                    <b>no goals left</b><br />
                    <i>This probably means you solved the level with warnings</i>
                  </p>
                }
              </div>
            )}
          </>
        }
      }) : <CircularProgress />}
    </div>
    <CommandLine proofPanelRef={proofPanelRef}/>
  </div>
}

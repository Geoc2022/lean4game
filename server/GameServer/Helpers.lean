import Lean

/-! This document contains various things which cluttered `Commands.lean`. -/

open Lean Meta Elab Command

syntax hintArg := atomic(" (" (&"strict" <|> &"hidden") " := " withoutPosition(term) ")")

/-! ## Doc Comment Parsing -/

/-- Read a doc comment and get its content. Return `""` if no doc comment available. -/
def parseDocComment! (doc: Option (TSyntax `Lean.Parser.Command.docComment)) :
    CommandElabM String := do
  match doc with
  | none =>
    logWarning "Add a text to this command with `/-- yada yada -/ MyCommand`!"
    pure ""
  | some s => match s.raw[1] with
    | .atom _ val => pure <| val.dropRight 2 |>.trim -- some (val.extract 0 (val.endPos - ⟨2⟩))
    | _           => pure "" --panic "not implemented error message" --throwErrorAt s "unexpected doc string{indentD s.raw[1]}"

/-- Read a doc comment and get its content. Return `none` if no doc comment available. -/
def parseDocComment (doc: Option (TSyntax `Lean.Parser.Command.docComment)) :
    CommandElabM <| Option String := do
  match doc with
  | none => pure none
  | some _ => parseDocComment! doc


/-- TODO: This is only used to provide some backwards compatibility and you can
replace `parseDocCommentLegacy` with `parseDocComment` in the future. -/
def parseDocCommentLegacy (doc: Option (TSyntax `Lean.Parser.Command.docComment))
    (t : Option (TSyntax `str)) : CommandElabM <| String := do
  match doc with
  | none =>
    match t with
    | none =>
      pure <| ← parseDocComment! doc
    | some t =>
      logWarningAt t "You should use the new Syntax:

      /-- yada yada -/
      YourCommand

      instead of

      YourCommand \"yada yada\"
      "
      pure t.getString
  | some _ =>
    match t with
      | none =>
        pure <| ← parseDocComment! doc
      | some t =>
        logErrorAt t "You must not provide both, a docstring and a string following the command!
        Only use

        /-- yada yada -/
        YourCommand

        and remove the string following it!"
        pure <| ← parseDocComment! doc

/-! ## Statement string -/

def getStatement (name : Name) : CommandElabM MessageData := do
  return ← addMessageContextPartial (.ofPPFormat { pp := fun
    | some ctx => ctx.runMetaM <| PrettyPrinter.ppSignature name
    | none     => return "that's a bug." })

-- Note: We use `String` because we can't send `MessageData` as json, but
-- `MessageData` might be better for interactive highlighting.
/-- Get a string of the form `my_lemma (n : ℕ) : n + n = 2 * n`.

Note: A statement like `theorem abc : ∀ x : Nat, x ≥ 0` would be turned into
`theorem abc (x : Nat) : x ≥ 0` by `PrettyPrinter.ppSignature`. -/
def getStatementString (name : Name) : CommandElabM String := do
  try
    return ← (← getStatement name).toString
  catch
  | _ => throwError m!"Could not find {name} in context."
  -- TODO: I think it would be nicer to unresolve Namespaces as much as possible.

/-- A `attr := ...` option for `Statement`. Add attributes to the defined theorem. -/
syntax statementAttr := "(" &"attr" ":=" Parser.Term.attrInstance,* ")"
-- TODO


/-- Remove any spaces at the beginning of a new line -/
partial def removeIndentation (s : String) : String :=
  let rec loop (i : String.Pos) (acc : String) (removeSpaces := false) : String :=
    let c := s.get i
    let i := s.next i
    if s.atEnd i then
      acc.push c
    else if removeSpaces && c == ' ' then
      loop i acc (removeSpaces := true)
    else if c == '\n' then
      loop i (acc.push c) (removeSpaces := true)
    else
      loop i (acc.push c)
  loop ⟨0⟩ ""


/-! ## Loops in Graph-like construct

TODO: Why are we not using graphs here but our own construct `HashMap Name (HashSet Name)`?
-/

partial def removeTransitiveAux (id : Name) (arrows : HashMap Name (HashSet Name))
      (newArrows : HashMap Name (HashSet Name)) (decendants : HashMap Name (HashSet Name)) :
    HashMap Name (HashSet Name) × HashMap Name (HashSet Name) := Id.run do
  match (newArrows.find? id, decendants.find? id) with
  | (some _, some _) => return (newArrows, decendants)
  | _ =>
    let mut newArr := newArrows
    let mut desc := decendants
    desc := desc.insert id {} -- mark as worked in case of loops
    newArr := newArr.insert id {} -- mark as worked in case of loops
    let children := arrows.findD id {}
    let mut trimmedChildren := children
    let mut theseDescs := children
    for child in children do
      (newArr, desc) := removeTransitiveAux child arrows newArr desc
      let childDescs := desc.findD child {}
      theseDescs := theseDescs.insertMany childDescs
      for d in childDescs do
        trimmedChildren := trimmedChildren.erase d
    desc := desc.insert id theseDescs
    newArr := newArr.insert id trimmedChildren
    return (newArr, desc)


def removeTransitive (arrows : HashMap Name (HashSet Name)) : CommandElabM (HashMap Name (HashSet Name)) := do
  let mut newArr := {}
  let mut desc := {}
  for id in arrows.toArray.map Prod.fst do
    (newArr, desc) := removeTransitiveAux id arrows newArr desc
    if (desc.findD id {}).contains id then
      logError <| m!"Loop at {id}. " ++
        m!"This should not happen and probably means that `findLoops` has a bug."
      -- DEBUG:
      -- for ⟨x, hx⟩ in desc.toList do
      --   m := m ++ m!"{x}: {hx.toList}\n"
      -- logError m

  return newArr

/-- The recursive part of `findLoops`. Finds loops that appear as successors of `node`.

For performance reason it returns a HashSet of visited
nodes as well. This is filled with all nodes ever looked at as they cannot be
part of a loop anymore. -/
partial def findLoopsAux (arrows : HashMap Name (HashSet Name)) (node : Name)
    (path : Array Name := #[]) (visited : HashSet Name := {}) :
    Array Name × HashSet Name := Id.run do
  let mut visited := visited
  match path.getIdx? node with
  | some i =>
    -- Found a loop: `node` is already the iᵗʰ element of the path
    return (path.extract i path.size, visited.insert node)
  | none =>
    for successor in arrows.findD node {} do
      -- If we already visited the successor, it cannot be part of a loop anymore
      if visited.contains successor then
        continue
      -- Find any loop involving `successor`
      let (loop, _) := findLoopsAux arrows successor (path.push node) visited
      visited := visited.insert successor
      -- No loop found in the dependants of `successor`
      if loop.isEmpty then
        continue
      -- Found a loop, return it
      return (loop, visited)
  return (#[], visited.insert node)

/-- Find a loop in the graph and return it. Returns `[]` if there are no loops. -/
partial def findLoops (arrows : HashMap Name (HashSet Name)) : List Name := Id.run do
  let mut visited : HashSet Name := {}
  for node in arrows.toArray.map (·.1) do
    -- Skip a node if it was already visited
    if visited.contains node then
      continue
    -- `findLoopsAux` returns a loop or `[]` together with a set of nodes it visited on its
    -- search starting from `node`
    let (loop, moreVisited) := (findLoopsAux arrows node (visited := visited))
    visited := moreVisited
    if !loop.isEmpty then
      return loop.toList
  return []

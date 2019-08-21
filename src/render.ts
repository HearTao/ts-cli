import { ts, SourceFile, FunctionDeclaration } from 'ts-morph'
import { TransformResult, getFunctionDeclarationDefaultName } from './transformer'
import { Context } from './generator'
import { defaults } from 'lodash'

const CLI_LIB_NAME: string = `yargs`
const FUNCTION_NAME: string = `cli`

export interface RenderOptions {
  lib: string
  functionName: string
  strict: boolean
  help: boolean
  helpAlias: boolean
  version: boolean
  asyncFunction: boolean
  runnable: boolean
}

export const DEFAULT_RENDER_OPTIONS: RenderOptions = {
  lib: CLI_LIB_NAME,
  functionName: FUNCTION_NAME,
  strict: true,
  help: true,
  helpAlias: true,
  version: true,
  asyncFunction: false,
  runnable: false
}

export default function render(result: TransformResult, outputSourceFile: SourceFile, entrySourceFile: SourceFile, options: Partial<RenderOptions> = {}, context: Context): ts.Node[] {
  const opts = defaults(options, DEFAULT_RENDER_OPTIONS)
  const { lib, strict, help, helpAlias, version } = opts
  const acc = []

  if(strict) acc.push(ts.createCall(ts.createIdentifier('strict'), undefined, []))
  acc.push(makeCommandNode(result))
  if(help) acc.push(ts.createCall(ts.createIdentifier('help'), undefined, []))
  if(helpAlias) acc.push(ts.createCall(ts.createIdentifier('alias'), undefined, [ ts.createStringLiteral('help'), ts.createStringLiteral('h') ]))
  if(version) acc.push(ts.createCall(ts.createIdentifier('version'), undefined, []))
  acc.push(ts.createCall(ts.createIdentifier('parse'), undefined, [ ts.createIdentifier('args') ]))

  const callableChainNodes = generateCallableChain(acc, ts.createIdentifier(lib))

  const yargsNode =
  ts.createExpressionStatement(
    callableChainNodes
  )
  
  return makeWrapper([ yargsNode ], {
    outputSourceFile, 
    entrySourceFile, 
    result, 
    context,
    options: opts
  })
}

// #region wrapper

interface MakeWrapperOptions {
  outputSourceFile: SourceFile
  entrySourceFile: SourceFile
  result: TransformResult
  context: Context
  options: RenderOptions
}

export function makeWrapper(body: ts.Statement[] = [], options: MakeWrapperOptions): ts.Node[] {
  const nodes: ReturnType<typeof makeWrapper> = []
  nodes.push(makeLibImportDeclarationNode(`yargs`, `yargs`, options.context))
  
  if(options.context.stdin) {
    options.entrySourceFile.getStatements().forEach(stmt => nodes.push(stmt.compilerNode))
  } else {
    makeRefImportDeclarationNode(options.outputSourceFile, options.result).forEach(node => nodes.push(node))
  }

  nodes.push(makeWrapperFunctionDeclaration(body, options.options))

  if(options.options.runnable || options.context.stdin) {
    nodes.push(makeCliCallNode(options.options.functionName, options.context.args))
  }

  return nodes
}

export function makeCliCallNode(name: string, args?: string[]): ts.Node {
  return ts.createCall(
    ts.createIdentifier(name),
    undefined,
    [
      ...(args ? ts.createArrayLiteral(args.map(arg => ts.createStringLiteral(arg)), false) : [])
    ]
  )
}

export function makeLibImportDeclarationNode(exporter: string, path: string, context: Context): ts.ImportDeclaration {
  const modulePath = context.stdin ? require.resolve(path) : path
  return ts.createImportDeclaration(
    undefined,
    undefined,
    ts.createImportClause(
      undefined,
      ts.createNamespaceImport(
        ts.createIdentifier(exporter)
      ),
    ),
    ts.createStringLiteral(modulePath)
  )
}

export function makeRefImportDeclarationNode(outputSourceFile: SourceFile, result: TransformResult): ts.ImportDeclaration[] {
  const acc: ReturnType<typeof makeRefImportDeclarationNode> = []
  result.ref.forEach(({ default: def, named }, sourceFile) => {
    const filePath = outputSourceFile.getRelativePathAsModuleSpecifierTo(sourceFile)
    const defaultExporter = 0 === def.length 
      ? undefined 
      : ts.createIdentifier(getFunctionDeclarationDefaultName(def[0].node as FunctionDeclaration))

    acc.push(
      ts.createImportDeclaration(
        undefined,
        undefined,
        ts.createImportClause(
          defaultExporter,
          ts.createNamedImports(
            named.map(info => {
              return ts.createImportSpecifier(
                undefined,
                ts.createIdentifier(info.name)
              )
            })
          )
    
        ),
        ts.createStringLiteral(filePath)
      )
    )
  })
  return acc
}

export function makeWrapperFunctionDeclaration(body: ts.Statement[] = [], options: RenderOptions): ts.FunctionDeclaration {
  const modifiers: ReturnType<typeof ts.createModifier>[] = [
    ts.createModifier(ts.SyntaxKind.ExportKeyword),
    ts.createModifier(ts.SyntaxKind.DefaultKeyword)
  ]

  if(options.asyncFunction) modifiers.push(ts.createModifier(ts.SyntaxKind.AsyncKeyword))
  
  const returnType = options.asyncFunction 
    ? ts.createTypeReferenceNode(ts.createIdentifier('Promise'), [
        ts.createKeywordTypeNode(ts.SyntaxKind.VoidKeyword)
      ])
    : ts.createKeywordTypeNode(ts.SyntaxKind.VoidKeyword)

  return ts.createFunctionDeclaration(
    undefined,
    modifiers,
    undefined,
    ts.createIdentifier(options.functionName),
    undefined,
    [
      ts.createParameter(
        undefined,
        undefined,
        undefined,
        ts.createIdentifier(`args`),
        undefined,
        ts.createArrayTypeNode(
          ts.createKeywordTypeNode(ts.SyntaxKind.StringKeyword)
        ),
        ts.createCall(
          ts.createPropertyAccess(
            ts.createPropertyAccess(
              ts.createIdentifier(`process`),
              ts.createIdentifier(`argv`)
            ),
            ts.createIdentifier(`slice`)
          ),
          undefined,
          [
            ts.createNumericLiteral(`2`)
          ]
        )
      )
    ],
    returnType,
    ts.createBlock(body, true)
  )
}

// #endregion

// #region commander

function makeCommandNode(result: TransformResult): ts.CallExpression {
  const commandNode = 
  ts.createCall(
    ts.createIdentifier('command'),
    undefined,
    [
      makePositionalCommandString(result),
      result.description,
      makeBuilder(result),
      makeHandler(result)
    ]
  )

  return commandNode
}

export function makePositionalCommandString(result: TransformResult): ts.StringLiteral {
  const { positionals, options } = result
  const acc: string[] = [`$0`]
  positionals.forEach(([ name ]) => acc.push(`<${name}>`))/**@todo optional positional like stdin */
  if(0 !== options.length) acc.push(`[...options]`)
  return ts.createStringLiteral(acc.join(` `))
}

export function makeBuilder(result: TransformResult): ts.ArrowFunction {
  const { positionals, options } = result

  const acc: ts.CallExpression[] = []
  positionals.forEach(([, call ]) => acc.push(call))
  options.forEach(([, call]) => acc.push(call))
  const callExpr = generateCallableChain(acc, ts.createIdentifier(`yargs`))

  const node = 
  ts.createArrowFunction(
    undefined,
    undefined,
    [
      ts.createParameter(
        undefined,
        undefined,
        undefined,
        ts.createIdentifier('yargs'),
        undefined,
        undefined,
        undefined
      )
    ],
    undefined,
    ts.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
    ts.createBlock(
      [
        ts.createReturn(
          callExpr
        )
      ], 
      true
    )
  )
  
  return node
}

export function makeHandler(result: TransformResult): ts.ArrowFunction {
  const { positionals, options } = result
  const acc: ts.CallExpression[] = []
  positionals.forEach(([, call ]) => acc.push(call))
  options.forEach(([, call ]) => acc.push(call))

  return makeArrowFunctionNode(`args`, [
    makeDeconstructNode(),
    makeCommandApplyNode()
  ])

  function makePositionalBindingNodes(): ts.BindingElement[] {
    return positionals.map(([ name ]) => {
      return ts.createBindingElement(
        undefined,
        undefined,
        ts.createIdentifier(name),
        undefined
      )
    })
  }

  function makePositionalIdentifierNodes(): ts.Identifier[] {
    return positionals.map(([ name ]) => {
      return ts.createIdentifier(name)
    })
  }

  function makeDeconstructNode(): ts.VariableStatement {
    return ts.createVariableStatement(
      undefined,
      ts.createVariableDeclarationList(
        [
          ts.createVariableDeclaration(
            ts.createObjectBindingPattern(
              [
                ts.createBindingElement(
                  undefined,
                  undefined,
                  ts.createIdentifier('_'),
                  undefined
                ),
                ts.createBindingElement(
                  undefined,
                  undefined,
                  ts.createIdentifier('$0'),
                  undefined
                ),
                ...makePositionalBindingNodes(),
                ...(options.length ? [ts.createBindingElement(
                  ts.createToken(ts.SyntaxKind.DotDotDotToken),
                  undefined,
                  ts.createIdentifier('options'),
                  undefined
                )] : [])
              ]
            ),
            undefined,
            ts.createIdentifier('args')
          )
        ],
        ts.NodeFlags.Const
      )
    )
  }

  function makeCommandApplyNode(): ts.ExpressionStatement {
    return ts.createExpressionStatement(
      ts.createCall(
        ts.createIdentifier(result.name), 
        undefined, 
        [
          ...makePositionalIdentifierNodes(),
          ...(options.length ? [ts.createIdentifier('options')] : [])
        ]
      )
    )
  }
}

export function makeArrowFunctionNode(iden: string, body: ts.Statement[] = []): ts.ArrowFunction {
  return ts.createArrowFunction(
    undefined,
    undefined,
    [
      ts.createParameter(
        undefined,
        undefined,
        undefined,
        ts.createIdentifier(iden),
        undefined,
        undefined,
        undefined
      )
    ],
    undefined,
    ts.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
    ts.createBlock(
      body, 
      false
    )
  )
}

// #endregion

// #region helper

export function generateCallableChain(calls: ts.CallExpression[], expr: ts.Expression): ts.CallExpression {
  return calls.reverse().reduce((acc, call) => {
    return expr => replaceCallableProperty(acc(call), expr)
  }, (a: ts.Expression) => a as ts.CallExpression)(expr)
}

export function replaceCallableProperty(call: ts.CallExpression, expr: ts.Expression): ts.CallExpression {
  return ts.createCall(
    ts.createPropertyAccess(
      expr,
      call.expression as ts.Identifier
    ),
    call.typeArguments,
    call.arguments
  )
}

// #endregion

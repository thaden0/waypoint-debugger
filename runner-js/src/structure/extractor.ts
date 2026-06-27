import ts from 'typescript';
import type { ClassModel, FileModel, FunctionModel, MemberModel, Param } from '../types.js';

// Parses JS/TS into the same language-neutral structure model the PHP runner
// emits. Uses the TypeScript compiler API — the JS analog of nikic/php-parser:
// it parses both JS and TS, gives a full AST with positions, and round-trips.

export class StructureExtractor {
  extractFile(path: string, source: string): FileModel {
    const kind = path.endsWith('.tsx') || path.endsWith('.jsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    let sf: ts.SourceFile;
    try {
      sf = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, kind);
    } catch (e) {
      return { path, kind: 'module', namespace: null, nodes: [], error: (e as Error).message };
    }

    const nodes: Array<ClassModel | FunctionModel> = [];

    const visit = (node: ts.Node) => {
      if (ts.isClassDeclaration(node) && node.name) {
        nodes.push(this.classToNode(node, sf, 'class'));
      } else if (ts.isInterfaceDeclaration(node)) {
        nodes.push(this.interfaceToNode(node, sf));
      } else if (ts.isFunctionDeclaration(node) && node.name) {
        nodes.push(this.functionToNode(node, sf));
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);

    return { path, kind: 'module', namespace: null, nodes };
  }

  private classToNode(node: ts.ClassDeclaration, sf: ts.SourceFile, kind: 'class'): ClassModel {
    const name = node.name!.text;
    const members: MemberModel[] = [];

    let extendsName: string | null = null;
    const implementsNames: string[] = [];
    for (const clause of node.heritageClauses ?? []) {
      for (const t of clause.types) {
        const text = t.expression.getText(sf);
        if (clause.token === ts.SyntaxKind.ExtendsKeyword) extendsName = text;
        else implementsNames.push(text);
      }
    }

    for (const m of node.members) {
      if (ts.isMethodDeclaration(m) && m.name) {
        const visibility = this.visibility(m);
        const isStatic = this.hasModifier(m, ts.SyntaxKind.StaticKeyword);
        const isAbstract = this.hasModifier(m, ts.SyntaxKind.AbstractKeyword);
        members.push({
          kind: 'method',
          name: m.name.getText(sf),
          visibility,
          static: isStatic,
          abstract: isAbstract,
          params: m.parameters.map((p) => this.param(p, sf)),
          returnType: m.type ? m.type.getText(sf) : null,
          line: this.span(m, sf),
          // A waypoint anchors on a public instance method — the reconstruct+invoke unit.
          waypointEligible: visibility === 'public' && !isStatic && !isAbstract,
        });
      } else if (ts.isPropertyDeclaration(m) && m.name) {
        members.push({
          kind: 'property',
          name: m.name.getText(sf),
          visibility: this.visibility(m),
          static: this.hasModifier(m, ts.SyntaxKind.StaticKeyword),
          type: m.type ? m.type.getText(sf) : null,
          line: this.span(m, sf),
        });
      }
    }

    return {
      kind,
      name,
      namespace: null,
      fqn: name,
      extends: extendsName,
      implements: implementsNames,
      line: this.span(node, sf),
      members,
    };
  }

  private interfaceToNode(node: ts.InterfaceDeclaration, sf: ts.SourceFile): ClassModel {
    const members: MemberModel[] = [];
    for (const m of node.members) {
      if (ts.isMethodSignature(m) && m.name) {
        members.push({
          kind: 'method',
          name: m.name.getText(sf),
          visibility: 'public',
          static: false,
          params: m.parameters.map((p) => this.param(p, sf)),
          returnType: m.type ? m.type.getText(sf) : null,
          line: this.span(m, sf),
          waypointEligible: false,
        });
      } else if (ts.isPropertySignature(m) && m.name) {
        members.push({
          kind: 'property',
          name: m.name.getText(sf),
          visibility: 'public',
          static: false,
          type: m.type ? m.type.getText(sf) : null,
          line: this.span(m, sf),
        });
      }
    }
    return {
      kind: 'interface',
      name: node.name.text,
      namespace: null,
      fqn: node.name.text,
      extends: null,
      implements: [],
      line: this.span(node, sf),
      members,
    };
  }

  private functionToNode(node: ts.FunctionDeclaration, sf: ts.SourceFile): FunctionModel {
    return {
      kind: 'function',
      name: node.name!.text,
      line: this.span(node, sf),
      params: node.parameters.map((p) => this.param(p, sf)),
      returnType: node.type ? node.type.getText(sf) : null,
    };
  }

  private param(p: ts.ParameterDeclaration, sf: ts.SourceFile): Param {
    return {
      name: p.name.getText(sf),
      type: p.type ? p.type.getText(sf) : null,
      hasDefault: p.initializer !== undefined,
      variadic: p.dotDotDotToken !== undefined,
    };
  }

  private visibility(node: ts.Node): 'public' | 'protected' | 'private' {
    if (this.hasModifier(node, ts.SyntaxKind.PrivateKeyword)) return 'private';
    if (this.hasModifier(node, ts.SyntaxKind.ProtectedKeyword)) return 'protected';
    // A #private name field is also private.
    const name = (node as ts.MethodDeclaration).name;
    if (name && ts.isPrivateIdentifier(name)) return 'private';
    return 'public';
  }

  private hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
    const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
    return mods?.some((m) => m.kind === kind) ?? false;
  }

  private span(node: ts.Node, sf: ts.SourceFile): { start: number; end: number } {
    const start = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    const end = sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
    return { start, end };
  }
}

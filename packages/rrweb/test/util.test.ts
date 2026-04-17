/**
 * @vitest-environment jsdom
 */
import {
  getRootShadowHost,
  StyleSheetMirror,
  inDom,
  shadowHostInDom,
  getShadowHost,
  getNestedRule,
} from '../src/utils';

describe('Utilities for other modules', () => {
  describe('StyleSheetMirror', () => {
    it('should create a StyleSheetMirror', () => {
      const mirror = new StyleSheetMirror();
      expect(mirror).toBeDefined();
      expect(mirror.add).toBeDefined();
      expect(mirror.has).toBeDefined();
      expect(mirror.reset).toBeDefined();
      expect(mirror.getId).toBeDefined();
    });

    it('can add CSSStyleSheet into the mirror without ID parameter', () => {
      const mirror = new StyleSheetMirror();
      const styleSheet = new CSSStyleSheet();
      expect(mirror.has(styleSheet)).toBeFalsy();
      expect(mirror.add(styleSheet)).toEqual(1);
      expect(mirror.has(styleSheet)).toBeTruthy();
      // This stylesheet has been added before so just return its assigned id.
      expect(mirror.add(styleSheet)).toEqual(1);

      for (let i = 0; i < 10; i++) {
        const styleSheet = new CSSStyleSheet();
        expect(mirror.has(styleSheet)).toBeFalsy();
        expect(mirror.add(styleSheet)).toEqual(i + 2);
        expect(mirror.has(styleSheet)).toBeTruthy();
      }
    });

    it('can add CSSStyleSheet into the mirror with ID parameter', () => {
      const mirror = new StyleSheetMirror();
      for (let i = 0; i < 10; i++) {
        const styleSheet = new CSSStyleSheet();
        expect(mirror.has(styleSheet)).toBeFalsy();
        expect(mirror.add(styleSheet, i)).toEqual(i);
        expect(mirror.has(styleSheet)).toBeTruthy();
      }
    });

    it('can get the id from the mirror', () => {
      const mirror = new StyleSheetMirror();
      for (let i = 0; i < 10; i++) {
        const styleSheet = new CSSStyleSheet();
        mirror.add(styleSheet);
        expect(mirror.getId(styleSheet)).toBe(i + 1);
      }
      expect(mirror.getId(new CSSStyleSheet())).toBe(-1);
    });

    it('can get CSSStyleSheet objects with id', () => {
      const mirror = new StyleSheetMirror();
      for (let i = 0; i < 10; i++) {
        const styleSheet = new CSSStyleSheet();
        mirror.add(styleSheet);
        expect(mirror.getStyle(i + 1)).toBe(styleSheet);
      }
    });

    it('can reset the mirror', () => {
      const mirror = new StyleSheetMirror();
      const styleList: CSSStyleSheet[] = [];
      for (let i = 0; i < 10; i++) {
        const styleSheet = new CSSStyleSheet();
        mirror.add(styleSheet);
        expect(mirror.getId(styleSheet)).toBe(i + 1);
        styleList.push(styleSheet);
      }
      expect(mirror.reset()).toBeUndefined();
      for (let s of styleList) expect(mirror.has(s)).toBeFalsy();
      for (let i = 0; i < 10; i++) expect(mirror.getStyle(i + 1)).toBeNull();
      expect(mirror.add(new CSSStyleSheet())).toBe(1);
    });
  });

  describe('inDom()', () => {
    it('should get correct result given nested shadow doms', () => {
      const shadowHost = document.createElement('div');
      const shadowRoot = shadowHost.attachShadow({ mode: 'open' });
      const shadowHost2 = document.createElement('div');
      const shadowRoot2 = shadowHost2.attachShadow({ mode: 'open' });
      const div = document.createElement('div');
      shadowRoot.appendChild(shadowHost2);
      shadowRoot2.appendChild(div);
      // Not in Dom yet.
      expect(getShadowHost(div)).toBe(shadowHost2);
      expect(getRootShadowHost(div)).toBe(shadowHost);
      expect(shadowHostInDom(div)).toBeFalsy();
      expect(inDom(div)).toBeFalsy();

      // Added to the Dom.
      document.body.appendChild(shadowHost);
      expect(getShadowHost(div)).toBe(shadowHost2);
      expect(getRootShadowHost(div)).toBe(shadowHost);
      expect(shadowHostInDom(div)).toBeTruthy();
      expect(inDom(div)).toBeTruthy();
    });

    it('should get correct result given a normal node', () => {
      const div = document.createElement('div');
      // Not in Dom yet.
      expect(getShadowHost(div)).toBeNull();
      expect(getRootShadowHost(div)).toBe(div);
      expect(shadowHostInDom(div)).toBeFalsy();
      expect(inDom(div)).toBeFalsy();

      // Added to the Dom.
      document.body.appendChild(div);
      expect(getShadowHost(div)).toBeNull();
      expect(getRootShadowHost(div)).toBe(div);
      expect(shadowHostInDom(div)).toBeTruthy();
      expect(inDom(div)).toBeTruthy();
    });

    /**
     * Given the textNode of a detached HTMLAnchorElement, getRootNode() will return the anchor element itself and its host property is a string.
     * This corner case may cause an error in getRootShadowHost().
     */
    it('should get correct result given the textNode of a detached HTMLAnchorElement', () => {
      const a = document.createElement('a');
      a.href = 'example.com';
      a.textContent = 'something';
      // Not in Dom yet.
      expect(getShadowHost(a.childNodes[0])).toBeNull();
      expect(getRootShadowHost(a.childNodes[0])).toBe(a.childNodes[0]);
      expect(shadowHostInDom(a.childNodes[0])).toBeFalsy();
      expect(inDom(a.childNodes[0])).toBeFalsy();

      // Added to the Dom.
      document.body.appendChild(a);
      expect(getShadowHost(a.childNodes[0])).toBeNull();
      expect(getRootShadowHost(a.childNodes[0])).toBe(a.childNodes[0]);
      expect(shadowHostInDom(a.childNodes[0])).toBeTruthy();
      expect(inDom(a.childNodes[0])).toBeTruthy();
    });
  });

  describe('getNestedRule()', () => {
    let styleElement: HTMLStyleElement;
    let stylesheet: CSSStyleSheet;

    beforeEach(() => {
      // Create a style element with nested CSS rules for testing
      styleElement = document.createElement('style');
      document.head.appendChild(styleElement);
      stylesheet = styleElement.sheet as CSSStyleSheet;
    });

    afterEach(() => {
      document.head.removeChild(styleElement);
    });

    it('should return a top-level rule with single index [N]', () => {
      stylesheet.insertRule('.rule0 { color: red; }', 0);
      stylesheet.insertRule('.rule1 { color: blue; }', 1);
      stylesheet.insertRule('.rule2 { color: green; }', 2);

      const rule0 = getNestedRule(stylesheet.cssRules, [0]);
      expect((rule0 as CSSStyleRule).selectorText).toBe('.rule0');

      const rule1 = getNestedRule(stylesheet.cssRules, [1]);
      expect((rule1 as CSSStyleRule).selectorText).toBe('.rule1');

      const rule2 = getNestedRule(stylesheet.cssRules, [2]);
      expect((rule2 as CSSStyleRule).selectorText).toBe('.rule2');
    });

    it('should return a rule nested inside @media with index [0, N]', () => {
      // Insert @media rule with nested rules
      stylesheet.insertRule(
        '@media (min-width: 100px) { .rule0 { color: red; } .rule1 { color: blue; } .rule2 { color: green; } }',
        0,
      );

      const mediaRule = stylesheet.cssRules[0] as CSSMediaRule;
      expect(mediaRule.cssRules.length).toBe(3);

      // Access nested rules using [0, N] where 0 is the @media index
      const nestedRule0 = getNestedRule(stylesheet.cssRules, [0, 0]);
      expect((nestedRule0 as CSSStyleRule).selectorText).toBe('.rule0');

      const nestedRule1 = getNestedRule(stylesheet.cssRules, [0, 1]);
      expect((nestedRule1 as CSSStyleRule).selectorText).toBe('.rule1');

      const nestedRule2 = getNestedRule(stylesheet.cssRules, [0, 2]);
      expect((nestedRule2 as CSSStyleRule).selectorText).toBe('.rule2');
    });

    it('should return a rule nested inside @supports with index [0, N]', () => {
      // Insert @supports rule with nested rules
      stylesheet.insertRule(
        '@supports (display: grid) { .grid-rule { display: grid; } }',
        0,
      );

      const supportsRule = stylesheet.cssRules[0] as CSSSupportsRule;
      expect(supportsRule.cssRules.length).toBe(1);

      const nestedRule = getNestedRule(stylesheet.cssRules, [0, 0]);
      expect((nestedRule as CSSStyleRule).selectorText).toBe('.grid-rule');
    });

    it('should return a doubly nested rule with index [0, 0, N]', () => {
      // Insert @media containing @supports containing a rule
      stylesheet.insertRule(
        '@media (min-width: 100px) { @supports (display: grid) { .nested-rule { color: red; } } }',
        0,
      );

      const mediaRule = stylesheet.cssRules[0] as CSSMediaRule;
      const supportsRule = mediaRule.cssRules[0] as CSSSupportsRule;
      expect(supportsRule.cssRules.length).toBe(1);

      // Access doubly nested rule using [0, 0, 0]
      const nestedRule = getNestedRule(stylesheet.cssRules, [0, 0, 0]);
      expect((nestedRule as CSSStyleRule).selectorText).toBe('.nested-rule');
    });

    it('should handle @media at different indices in stylesheet', () => {
      // Insert some top-level rules first
      stylesheet.insertRule('.top-level { color: black; }', 0);
      stylesheet.insertRule(
        '@media (min-width: 100px) { .inside-media { color: red; } }',
        1,
      );

      // Top-level rule at index 0
      const topLevel = getNestedRule(stylesheet.cssRules, [0]);
      expect((topLevel as CSSStyleRule).selectorText).toBe('.top-level');

      // Nested rule: @media at index 1, rule at index 0 inside
      const insideMedia = getNestedRule(stylesheet.cssRules, [1, 0]);
      expect((insideMedia as CSSStyleRule).selectorText).toBe('.inside-media');
    });
  });
});

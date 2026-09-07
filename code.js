// Missing Library Finder - Figma Plugin Backend
// Fast, accurate detection of remote/missing library styles and missing fonts.
// Avoids unnecessary 403 network calls by default for instant, error-free scanning.

figma.showUI(__html__, {
  width: 450,
  height: 620,
  themeColors: true,
  title: 'Missing Library Finder'
});

// Cache for style and variable lookups
const styleCache = new Map();
const variableCache = new Map();
let cachedAvailableFonts = null;
let cachedFontFamilySet = null;

// Scan state tracking to prevent overlapping scans and support cancellation
let isScanning = false;
let isScanCancelled = false;
let skippedPages = new Set();
let skipCurrentPage = false;
let currentPageIndexBeingScanned = -1;
let currentPageIdBeingScanned = null;

// Helper: yield execution to allow UI event loop and IPC messages to process without freezing
function yieldToEventLoop() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

// Configurable detection settings
const defaultSettings = {
  detectShapeColors: true,
  detectTextColors: true,
  detectFills: true,
  detectStrokes: true,
  detectVariables: true,
  detectTextStyles: true,
  detectMissingFonts: true,
  detectEffects: true,
  scanHiddenLayers: true,
  scope: 'all'
};

let currentSettings = { ...defaultSettings };

// Safe async property and style setters for Figma dynamic-page compatibility
async function setNodeFillStyleId(node, styleId) {
  if (typeof node.setFillStyleIdAsync === 'function') {
    await node.setFillStyleIdAsync(styleId);
  } else {
    node.fillStyleId = styleId;
  }
}

async function setNodeStrokeStyleId(node, styleId) {
  if (typeof node.setStrokeStyleIdAsync === 'function') {
    await node.setStrokeStyleIdAsync(styleId);
  } else {
    node.strokeStyleId = styleId;
  }
}

async function setNodeTextStyleId(node, styleId) {
  if (typeof node.setTextStyleIdAsync === 'function') {
    await node.setTextStyleIdAsync(styleId);
  } else {
    node.textStyleId = styleId;
  }
}

async function setNodeEffectStyleId(node, styleId) {
  if (typeof node.setEffectStyleIdAsync === 'function') {
    await node.setEffectStyleIdAsync(styleId);
  } else {
    node.effectStyleId = styleId;
  }
}

async function setNodeRangeFillStyleId(node, start, end, styleId) {
  if (typeof node.setRangeFillStyleIdAsync === 'function') {
    await node.setRangeFillStyleIdAsync(start, end, styleId);
  } else if (typeof node.setRangeFillStyleId === 'function') {
    node.setRangeFillStyleId(start, end, styleId);
  }
}

async function setNodeRangeTextStyleId(node, start, end, styleId) {
  if (typeof node.setRangeTextStyleIdAsync === 'function') {
    await node.setRangeTextStyleIdAsync(start, end, styleId);
  } else if (typeof node.setRangeTextStyleId === 'function') {
    node.setRangeTextStyleId(start, end, styleId);
  }
}

async function setNodeRangeFontName(node, start, end, font) {
  if (typeof node.setRangeFontNameAsync === 'function') {
    await node.setRangeFontNameAsync(start, end, font);
  } else if (typeof node.setRangeFontName === 'function') {
    node.setRangeFontName(start, end, font);
  }
}

async function setNodeFontName(node, font) {
  if (typeof node.setFontNameAsync === 'function') {
    await node.setFontNameAsync(font);
  } else {
    node.fontName = font;
  }
}

async function setNodeFills(node, fills) {
  if (typeof node.setFillsAsync === 'function') {
    await node.setFillsAsync(fills);
  } else {
    try { node.fills = fills; } catch (e) { }
  }
}

async function setNodeStrokes(node, strokes) {
  if (typeof node.setStrokesAsync === 'function') {
    await node.setStrokesAsync(strokes);
  } else {
    try { node.strokes = strokes; } catch (e) { }
  }
}

async function setNodeEffects(node, effects) {
  if (typeof node.setEffectsAsync === 'function') {
    await node.setEffectsAsync(effects);
  } else {
    try { node.effects = effects; } catch (e) { }
  }
}

// Helper: extract preview hex color from style paints (supports SOLID and GRADIENT)
function computeStylePreview(style) {
  if (!style || !style.paints || !Array.isArray(style.paints) || style.paints.length === 0) return null;
  const solid = style.paints.find(p => p.type === 'SOLID' && p.visible !== false);
  if (solid && solid.color) return rgbToHex(solid.color, solid.opacity);
  const grad = style.paints.find(p => p.type && p.type.startsWith('GRADIENT') && p.visible !== false && Array.isArray(p.gradientStops) && p.gradientStops.length > 0);
  if (grad && grad.gradientStops[0] && grad.gradientStops[0].color) {
    return rgbToHex(grad.gradientStops[0].color, grad.gradientStops[0].color.a);
  }
  return null;
}

// Helper: extract color from variable valuesByMode if resolvedType is COLOR
function getVariablePreviewColor(variable) {
  if (!variable || variable.resolvedType !== 'COLOR' || !variable.valuesByMode) return null;
  const modeIds = Object.keys(variable.valuesByMode);
  for (let i = 0; i < modeIds.length; i++) {
    const val = variable.valuesByMode[modeIds[i]];
    if (val && typeof val === 'object' && 'r' in val && 'g' in val && 'b' in val) {
      return rgbToHex(val, val.a !== undefined ? val.a : 1);
    }
  }
  return null;
}

// Helper: check style status (fetches remote style metadata including color names)
async function checkStyle(styleId) {
  if (!styleId || typeof styleId !== 'string') return null;
  const cacheKey = styleId;
  const cached = styleCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  // Look up style asynchronously (official Figma API for local and library styles)
  let style = null;
  if (typeof figma.getStyleByIdAsync === 'function') {
    try {
      style = await figma.getStyleByIdAsync(styleId);
    } catch (e) {
      style = null;
    }
  }
  if (!style && typeof figma.getStyleById === 'function') {
    try {
      style = figma.getStyleById(styleId);
    } catch (e) {
      style = null;
    }
  }

  // If not found in document or library, it's missing/unlinked
  if (!style) {
    const res = {
      isMissing: true,
      name: null,
      rawId: styleId,
      remote: true,
      style: null,
      paints: null,
      previewColor: null
    };
    styleCache.set(cacheKey, res);
    return res;
  }

  // Local style created in this file -> check if any of its paints are bound to a missing variable
  if (!style.remote) {
    let hasMissingVar = false;
    let missingVarInfo = null;
    let missingVarId = null;

    if (style.paints && Array.isArray(style.paints)) {
      for (let i = 0; i < style.paints.length; i++) {
        const p = style.paints[i];
        if (!p) continue;
        if (p.boundVariables && p.boundVariables.color) {
          const vId = typeof p.boundVariables.color === 'object' && p.boundVariables.color ? p.boundVariables.color.id : p.boundVariables.color;
          if (vId && typeof vId === 'string') {
            let vInfo = variableCache.get(vId);
            if (vInfo === undefined) vInfo = await checkVariable(vId);
            if (vInfo && vInfo.isMissing) {
              hasMissingVar = true;
              missingVarInfo = vInfo;
              missingVarId = vId;
              break;
            }
          }
        }
        if (p.type && p.type.startsWith('GRADIENT') && Array.isArray(p.gradientStops)) {
          for (let s = 0; s < p.gradientStops.length; s++) {
            const stop = p.gradientStops[s];
            if (stop && stop.boundVariables && stop.boundVariables.color) {
              const vId = typeof stop.boundVariables.color === 'object' && stop.boundVariables.color ? stop.boundVariables.color.id : stop.boundVariables.color;
              if (vId && typeof vId === 'string') {
                let vInfo = variableCache.get(vId);
                if (vInfo === undefined) vInfo = await checkVariable(vId);
                if (vInfo && vInfo.isMissing) {
                  hasMissingVar = true;
                  missingVarInfo = vInfo;
                  missingVarId = vId;
                  break;
                }
              }
            }
          }
        }
        if (hasMissingVar) break;
      }
    }

    const res = {
      isMissing: hasMissingVar,
      name: style.name,
      rawId: styleId,
      remote: false,
      style: style,
      paints: style.paints || null,
      previewColor: computeStylePreview(style),
      missingVariable: missingVarInfo,
      missingVariableId: missingVarId
    };
    styleCache.set(cacheKey, res);
    if (style.key) {
      styleCache.set(style.key, res);
      styleCache.set(`S:${style.key}`, res);
      styleCache.set(`S:${style.key},`, res);
    }
    return res;
  }

  // Remote style (from external library)
  const res = {
    isMissing: true,
    name: style.name || null,
    rawId: styleId,
    remote: true,
    style: style,
    paints: style.paints || null,
    key: style.key,
    previewColor: computeStylePreview(style)
  };
  styleCache.set(cacheKey, res);
  if (style.key) {
    styleCache.set(style.key, res);
    styleCache.set(`S:${style.key}`, res);
    styleCache.set(`S:${style.key},`, res);
  }
  return res;
}

// Helper: check variable status (fetches remote variable metadata including names)
async function checkVariable(variableId) {
  if (!variableId || typeof variableId !== 'string') return null;
  const cacheKey = variableId;
  if (variableCache.has(cacheKey)) {
    return variableCache.get(cacheKey);
  }

  let variable = null;
  if (figma.variables && typeof figma.variables.getVariableByIdAsync === 'function') {
    try {
      variable = await figma.variables.getVariableByIdAsync(variableId);
    } catch (err) {
      variable = null;
    }
  }
  if (!variable && figma.variables && typeof figma.variables.getVariableById === 'function') {
    try {
      variable = figma.variables.getVariableById(variableId);
    } catch (err) {
      variable = null;
    }
  }

  if (!variable) {
    const res = {
      isMissing: true,
      name: null,
      rawId: variableId,
      remote: true,
      variable: null,
      previewColor: null
    };
    variableCache.set(cacheKey, res);
    return res;
  }

  if (!variable.remote) {
    let hasMissingAlias = false;
    let missingAliasId = null;
    let missingAliasInfo = null;

    if (variable.valuesByMode && typeof variable.valuesByMode === 'object') {
      const modeKeys = Object.keys(variable.valuesByMode);
      for (let m = 0; m < modeKeys.length; m++) {
        const val = variable.valuesByMode[modeKeys[m]];
        if (val && typeof val === 'object' && val.type === 'VARIABLE_ALIAS' && val.id) {
          let aliasInfo = variableCache.get(val.id);
          if (aliasInfo === undefined) aliasInfo = await checkVariable(val.id);
          if (aliasInfo && aliasInfo.isMissing) {
            hasMissingAlias = true;
            missingAliasId = val.id;
            missingAliasInfo = aliasInfo;
            break;
          }
        }
      }
    }

    const res = {
      isMissing: hasMissingAlias,
      name: variable.name,
      rawId: variableId,
      remote: false,
      variable: variable,
      previewColor: getVariablePreviewColor(variable),
      missingAliasId,
      missingAliasInfo
    };
    variableCache.set(cacheKey, res);
    if (variable.key) variableCache.set(variable.key, res);
    return res;
  }

  const res = {
    isMissing: true,
    name: variable.name || null,
    rawId: variableId,
    remote: true,
    variable: variable,
    key: variable.key,
    previewColor: getVariablePreviewColor(variable)
  };
  variableCache.set(cacheKey, res);
  if (variable.key) variableCache.set(variable.key, res);
  return res;
}

// Helper: get list of available fonts
async function getAvailableFontsMap() {
  if (cachedAvailableFonts) return { fonts: cachedAvailableFonts, familySet: cachedFontFamilySet };
  try {
    const fonts = await figma.listAvailableFontsAsync();
    const fontSet = new Set();
    const familySet = new Set();
    for (let i = 0; i < fonts.length; i++) {
      const f = fonts[i];
      fontSet.add(`${f.fontName.family}::${f.fontName.style}`);
      familySet.add(f.fontName.family);
    }
    cachedAvailableFonts = fontSet;
    cachedFontFamilySet = familySet;
    return { fonts: fontSet, familySet: familySet };
  } catch (e) {
    return { fonts: new Set(), familySet: new Set() };
  }
}

// Helper: convert RGB/RGBA to Hex string
function rgbToHex(color, opacity = 1) {
  if (!color) return '#CCCCCC';
  const r = Math.round(color.r * 255).toString(16).padStart(2, '0');
  const g = Math.round(color.g * 255).toString(16).padStart(2, '0');
  const b = Math.round(color.b * 255).toString(16).padStart(2, '0');
  return `#${r}${g}${b}`.toUpperCase();
}

// Helper: extract swatch representation (supports SOLID, GRADIENT, targetPaint, node paints)
function getPreviewColor(node, type, styleInfo = null, targetPaint = null) {
  try {
    if (styleInfo && styleInfo.previewColor) return styleInfo.previewColor;
    if (targetPaint) {
      if (targetPaint.type === 'SOLID' && targetPaint.color) {
        return rgbToHex(targetPaint.color, targetPaint.opacity);
      }
      if (targetPaint.type && targetPaint.type.startsWith('GRADIENT') && Array.isArray(targetPaint.gradientStops) && targetPaint.gradientStops.length > 0) {
        const stop = targetPaint.gradientStops[0];
        if (stop && stop.color) return rgbToHex(stop.color, stop.color.a);
      }
    }
    // 1. Try style definition paints first
    if (styleInfo && styleInfo.paints && Array.isArray(styleInfo.paints) && styleInfo.paints.length > 0) {
      const preview = computeStylePreview(styleInfo);
      if (preview) {
        styleInfo.previewColor = preview;
        return preview;
      }
    }
    // 2. Try node paints
    if (node) {
      let paints = [];
      if (type.includes('stroke') && 'strokes' in node && Array.isArray(node.strokes)) {
        paints = node.strokes;
      } else if ('fills' in node && Array.isArray(node.fills)) {
        paints = node.fills;
      } else if (node.type === 'PAGE' && 'backgrounds' in node && Array.isArray(node.backgrounds)) {
        paints = node.backgrounds;
      }
      const solid = paints.find(p => p.type === 'SOLID' && p.visible !== false);
      if (solid && solid.color) {
        return rgbToHex(solid.color, solid.opacity);
      }
      const grad = paints.find(p => p.type && p.type.startsWith('GRADIENT') && p.visible !== false && Array.isArray(p.gradientStops) && p.gradientStops.length > 0);
      if (grad && grad.gradientStops[0] && grad.gradientStops[0].color) {
        return rgbToHex(grad.gradientStops[0].color, grad.gradientStops[0].color.a);
      }
    }
  } catch (e) { }
  return '#A0AEC0';
}

// Helper: inspect any paint array (fills, strokes, backgrounds, segment fills) for paint-level and gradient-stop bound variables
async function checkPaintArrayVariables(paints, type, node, page, visitedVarIds, addMissingColorFn) {
  if (!paints || !Array.isArray(paints)) return;
  for (let i = 0; i < paints.length; i++) {
    const paint = paints[i];
    if (!paint) continue;

    // Direct paint-level bound variable
    if (paint.boundVariables && paint.boundVariables.color) {
      const varAlias = paint.boundVariables.color;
      const varId = typeof varAlias === 'object' && varAlias ? varAlias.id : varAlias;
      if (varId && typeof varId === 'string' && !visitedVarIds.has(varId)) {
        visitedVarIds.add(varId);
        let varInfo = variableCache.get(varId);
        if (varInfo === undefined) varInfo = await checkVariable(varId);
        if (varInfo && varInfo.isMissing) {
          const key = `var-${type}:${varId}`;
          const previewColor = (varInfo && varInfo.previewColor) || getPreviewColor(node, type, null, paint);
          const displayName = varInfo.name || `Remote Variable (${previewColor})`;
          addMissingColorFn(key, varId, 'variable', displayName, previewColor, node, page);
        }
      }
    }

    // Gradient stop-level bound variables
    if (paint.type && paint.type.startsWith('GRADIENT') && Array.isArray(paint.gradientStops)) {
      for (let s = 0; s < paint.gradientStops.length; s++) {
        const stop = paint.gradientStops[s];
        if (stop && stop.boundVariables && stop.boundVariables.color) {
          const varAlias = stop.boundVariables.color;
          const varId = typeof varAlias === 'object' && varAlias ? varAlias.id : varAlias;
          if (varId && typeof varId === 'string' && !visitedVarIds.has(varId)) {
            visitedVarIds.add(varId);
            let varInfo = variableCache.get(varId);
            if (varInfo === undefined) varInfo = await checkVariable(varId);
            if (varInfo && varInfo.isMissing) {
              const key = `var-${type}:${varId}`;
              const stopColor = (stop.color) ? rgbToHex(stop.color, stop.color.a) : null;
              const previewColor = (varInfo && varInfo.previewColor) || stopColor || getPreviewColor(node, type, null, paint);
              const displayName = varInfo.name || `Remote Variable (${previewColor})`;
              addMissingColorFn(key, varId, 'variable', displayName, previewColor, node, page);
            }
          }
        }
      }
    }
  }
}

// Find the page that owns a node
function getPageForNode(node) {
  let curr = node;
  while (curr && curr.type !== 'PAGE' && curr.parent) {
    curr = curr.parent;
  }
  return curr && curr.type === 'PAGE' ? curr : figma.currentPage;
}

// Scan nodes within specified scope
async function scanMissingItems(scope = 'all', newSettings = null) {
  if (isScanning) {
    console.log('Scan already in progress, skipping duplicate call.');
    return;
  }
  isScanning = true;
  isScanCancelled = false;
  skipCurrentPage = false;
  currentPageIndexBeingScanned = -1;
  currentPageIdBeingScanned = null;
  skippedPages.clear();

  if (newSettings && typeof newSettings === 'object') {
    currentSettings = { ...currentSettings, ...newSettings };
  }

  styleCache.clear();
  variableCache.clear();

  const missingColorsMap = new Map();
  const missingFontsMap = new Map();
  const missingEffectsMap = new Map();
  let totalScannedNodes = 0;

  const addMissingColor = (key, rawId, subType, displayName, previewColor, node, page) => {
    let item = missingColorsMap.get(key);
    if (!item) {
      item = {
        key,
        rawId,
        category: 'color',
        subType,
        name: displayName,
        previewColor: previewColor || '#A0AEC0',
        nodeIdSet: new Set(),
        nodes: []
      };
      missingColorsMap.set(key, item);
    } else {
      // Upgrade name if previously using a generic fallback
      if ((!item.name || item.name.startsWith('Remote Color') || item.name.startsWith('Remote Variable')) && displayName && !displayName.startsWith('Remote Color') && !displayName.startsWith('Remote Variable')) {
        item.name = displayName;
      }
      // Upgrade previewColor if previously fallback
      if ((!item.previewColor || item.previewColor === '#A0AEC0' || item.previewColor === '#CCCCCC') && previewColor && previewColor !== '#A0AEC0' && previewColor !== '#CCCCCC') {
        item.previewColor = previewColor;
      }
    }
    const nId = node.id || (node.type === 'PAGE' ? node.id : 'page-canvas');
    if (!item.nodeIdSet.has(nId)) {
      item.nodeIdSet.add(nId);
      item.nodes.push({
        id: nId,
        name: (node.name || (node.type === 'PAGE' ? `${node.name} (Background)` : 'Unnamed Layer')).slice(0, 100),
        type: node.type,
        pageId: page ? page.id : (node.type === 'PAGE' ? node.id : figma.currentPage.id),
        pageName: page ? page.name : (node.type === 'PAGE' ? node.name : figma.currentPage.name)
      });
    }
  };

  const addMissingFont = (key, rawId, subType, displayName, fontFam, fontSty, node, page) => {
    let item = missingFontsMap.get(key);
    if (!item) {
      item = {
        key,
        rawId,
        category: 'font',
        subType,
        name: displayName,
        fontFamily: fontFam,
        fontStyle: fontSty,
        nodeIdSet: new Set(),
        nodes: []
      };
      missingFontsMap.set(key, item);
    }
    if (!item.nodeIdSet.has(node.id)) {
      item.nodeIdSet.add(node.id);
      item.nodes.push({
        id: node.id,
        name: (node.name || 'Unnamed Text').slice(0, 100),
        type: node.type,
        pageId: page.id,
        pageName: page.name
      });
    }
  };

  const addMissingEffect = (key, rawId, subType, displayName, node, page) => {
    let item = missingEffectsMap.get(key);
    if (!item) {
      item = {
        key,
        rawId,
        category: 'effect',
        subType,
        name: displayName,
        nodeIdSet: new Set(),
        nodes: []
      };
      missingEffectsMap.set(key, item);
    }
    if (!item.nodeIdSet.has(node.id)) {
      item.nodeIdSet.add(node.id);
      item.nodes.push({
        id: node.id,
        name: (node.name || 'Unnamed Layer').slice(0, 100),
        type: node.type,
        pageId: page.id,
        pageName: page.name
      });
    }
  };

  try {
    // Parallel pre-indexing of local styles, variables, and fonts
    let availableFontSet = new Set();
    try {
      const paintStylesPromise = typeof figma.getLocalPaintStylesAsync === 'function'
        ? figma.getLocalPaintStylesAsync()
        : Promise.resolve(figma.getLocalPaintStyles ? figma.getLocalPaintStyles() : []);
      const textStylesPromise = typeof figma.getLocalTextStylesAsync === 'function'
        ? figma.getLocalTextStylesAsync()
        : Promise.resolve(figma.getLocalTextStyles ? figma.getLocalTextStyles() : []);
      const effectStylesPromise = typeof figma.getLocalEffectStylesAsync === 'function'
        ? figma.getLocalEffectStylesAsync()
        : Promise.resolve(figma.getLocalEffectStyles ? figma.getLocalEffectStyles() : []);
      const localVarsPromise = (figma.variables && typeof figma.variables.getLocalVariablesAsync === 'function')
        ? figma.variables.getLocalVariablesAsync()
        : Promise.resolve((figma.variables && figma.variables.getLocalVariables) ? figma.variables.getLocalVariables() : []);
      const fontsPromise = getAvailableFontsMap();

      const [paintStyles, textStyles, effectStyles, localVars, fontsData] = await Promise.all([
        paintStylesPromise.catch(() => []),
        textStylesPromise.catch(() => []),
        effectStylesPromise.catch(() => []),
        localVarsPromise.catch(() => []),
        fontsPromise.catch(() => ({ fonts: new Set() }))
      ]);

      for (let i = 0; i < paintStyles.length; i++) {
        const s = paintStyles[i];
        if (!s) continue;
        if (s.remote) {
          const entry = {
            isMissing: true,
            name: s.name,
            rawId: s.id,
            remote: true,
            style: s,
            paints: s.paints || null,
            key: s.key,
            previewColor: computeStylePreview(s)
          };
          styleCache.set(s.id, entry);
          if (s.key) {
            styleCache.set(s.key, entry);
            styleCache.set(`S:${s.key}`, entry);
            styleCache.set(`S:${s.key},`, entry);
          }
        } else {
          let hasBoundVar = false;
          if (s.paints && Array.isArray(s.paints)) {
            for (const p of s.paints) {
              if (p && p.boundVariables && p.boundVariables.color) { hasBoundVar = true; break; }
            }
          }
          if (!hasBoundVar) {
            const entry = {
              isMissing: false,
              name: s.name,
              rawId: s.id,
              remote: false,
              style: s,
              paints: s.paints || null,
              previewColor: computeStylePreview(s)
            };
            styleCache.set(s.id, entry);
            if (s.key) {
              styleCache.set(s.key, entry);
              styleCache.set(`S:${s.key}`, entry);
              styleCache.set(`S:${s.key},`, entry);
            }
          }
        }
      }

      for (let i = 0; i < textStyles.length; i++) {
        const s = textStyles[i];
        if (!s) continue;
        if (s.remote) {
          const entry = {
            isMissing: true,
            name: s.name,
            rawId: s.id,
            remote: true,
            style: s,
            paints: null,
            key: s.key,
            previewColor: null
          };
          styleCache.set(s.id, entry);
          if (s.key) {
            styleCache.set(s.key, entry);
            styleCache.set(`S:${s.key}`, entry);
            styleCache.set(`S:${s.key},`, entry);
          }
        } else {
          const entry = {
            isMissing: false,
            name: s.name,
            rawId: s.id,
            remote: false,
            style: s,
            paints: null,
            previewColor: null
          };
          styleCache.set(s.id, entry);
          if (s.key) {
            styleCache.set(s.key, entry);
            styleCache.set(`S:${s.key}`, entry);
            styleCache.set(`S:${s.key},`, entry);
          }
        }
      }

      for (let i = 0; i < effectStyles.length; i++) {
        const s = effectStyles[i];
        if (!s) continue;
        if (s.remote) {
          const entry = {
            isMissing: true,
            name: s.name,
            rawId: s.id,
            remote: true,
            style: s,
            paints: null,
            key: s.key,
            previewColor: null
          };
          styleCache.set(s.id, entry);
          if (s.key) {
            styleCache.set(s.key, entry);
            styleCache.set(`S:${s.key}`, entry);
            styleCache.set(`S:${s.key},`, entry);
          }
        } else {
          const entry = {
            isMissing: false,
            name: s.name,
            rawId: s.id,
            remote: false,
            style: s,
            paints: null,
            previewColor: null
          };
          styleCache.set(s.id, entry);
          if (s.key) {
            styleCache.set(s.key, entry);
            styleCache.set(`S:${s.key}`, entry);
            styleCache.set(`S:${s.key},`, entry);
          }
        }
      }

      for (let i = 0; i < localVars.length; i++) {
        const v = localVars[i];
        if (!v) continue;
        if (v.remote) {
          const entry = {
            isMissing: true,
            name: v.name,
            rawId: v.id,
            remote: true,
            variable: v,
            key: v.key,
            previewColor: getVariablePreviewColor(v)
          };
          variableCache.set(v.id, entry);
          if (v.key) variableCache.set(v.key, entry);
        } else {
          let hasAlias = false;
          if (v.valuesByMode && typeof v.valuesByMode === 'object') {
            const mKeys = Object.keys(v.valuesByMode);
            for (let m = 0; m < mKeys.length; m++) {
              const val = v.valuesByMode[mKeys[m]];
              if (val && typeof val === 'object' && val.type === 'VARIABLE_ALIAS') {
                hasAlias = true;
                break;
              }
            }
          }
          if (!hasAlias) {
            const entry = {
              isMissing: false,
              name: v.name,
              rawId: v.id,
              remote: false,
              variable: v,
              previewColor: getVariablePreviewColor(v)
            };
            variableCache.set(v.id, entry);
            if (v.key) variableCache.set(v.key, entry);
          }
        }
      }

      availableFontSet = fontsData && fontsData.fonts ? fontsData.fonts : new Set();
    } catch (e) {
      console.warn('Error during parallel pre-indexing:', e);
    }

    const pagesToScan = [];
    if (scope === 'all') {
      for (const page of figma.root.children) {
        if (page.type === 'PAGE') {
          pagesToScan.push(page);
        }
      }
    } else {
      pagesToScan.push(figma.currentPage);
    }

    // Immediately broadcast the list of pages to be scanned
    figma.ui.postMessage({
      type: 'scan-init-pages',
      pages: pagesToScan.map((p, idx) => ({
        id: p.id,
        name: p.name || `Page ${idx + 1}`,
        index: idx
      }))
    });

    for (let pIdx = 0; pIdx < pagesToScan.length; pIdx++) {
      if (isScanCancelled) break;
      const page = pagesToScan[pIdx];
      currentPageIndexBeingScanned = pIdx;
      currentPageIdBeingScanned = page.id;

      // Check if page was paused/skipped by user from queue
      if (skippedPages.has(page.id) || skippedPages.has(pIdx)) {
        figma.ui.postMessage({
          type: 'scan-page-skipped',
          pageIndex: pIdx,
          pageId: page.id,
          pageName: page.name
        });
        await yieldToEventLoop();
        continue;
      }

      const basePercent = Math.round((pIdx / pagesToScan.length) * 100);
      figma.ui.postMessage({
        type: 'scan-progress',
        currentPageIndex: pIdx,
        currentPageName: page.name,
        totalPages: pagesToScan.length,
        inspectedLayers: 0,
        totalLayers: 0,
        status: `Page ${pIdx + 1}/${pagesToScan.length}: Loading ${page.name}...`,
        percent: basePercent
      });

      // Safe page loading with timeout safeguard
      if (typeof page.loadAsync === 'function') {
        try {
          await Promise.race([
            page.loadAsync(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Page load timed out')), 15000))
          ]);
        } catch (pageErr) {
          console.warn(`Could not load page "${page.name}":`, pageErr);
        }
      }

      await yieldToEventLoop();
      if (isScanCancelled) break;

      let allNodes = [];
      try {
        allNodes = page.findAll(node => {
          if (!currentSettings.scanHiddenLayers && 'visible' in node && !node.visible) {
            return false;
          }
          return true;
        });
      } catch (findErr) {
        console.warn(`findAll failed on page "${page.name}", falling back:`, findErr);
        try {
          allNodes = page.children || [];
        } catch (e) {
          allNodes = [];
        }
      }

      // Check page canvas background for missing colors or variables
      if (currentSettings.detectVariables && page.backgrounds && Array.isArray(page.backgrounds)) {
        await checkPaintArrayVariables(page.backgrounds, 'fill', page, page, new Set(), addMissingColor);
      }

      totalScannedNodes += allNodes.length;
      let lastYieldTime = Date.now();

      for (let nIdx = 0; nIdx < allNodes.length; nIdx++) {
        if (isScanCancelled) break;
        if (skipCurrentPage) {
          skipCurrentPage = false;
          figma.ui.postMessage({
            type: 'scan-page-skipped',
            pageIndex: pIdx,
            pageId: page.id,
            pageName: page.name
          });
          break;
        }

        // Adaptive high-speed yielding: batches 500 nodes or yields if >45ms elapsed
        if (nIdx > 0 && (nIdx % 500 === 0 || (nIdx % 100 === 0 && (Date.now() - lastYieldTime > 45)))) {
          await yieldToEventLoop();
          lastYieldTime = Date.now();
          if (isScanCancelled) break;
          const pageRatio = allNodes.length > 0 ? (nIdx / allNodes.length) : 0;
          const currentPercent = Math.min(99, Math.round(((pIdx + pageRatio) / pagesToScan.length) * 100));
          figma.ui.postMessage({
            type: 'scan-progress',
            currentPageIndex: pIdx,
            currentPageName: page.name,
            totalPages: pagesToScan.length,
            inspectedLayers: nIdx,
            totalLayers: allNodes.length,
            status: `Scanning ${page.name} (${Math.round(pageRatio * 100)}%)...`,
            percent: currentPercent
          });
        }

        const node = allNodes[nIdx];
        if (!node) continue;

        try {
          const nodeType = node.type;
          // Skip non-stylable container types immediately
          if (nodeType === 'GROUP' || nodeType === 'SLICE') continue;

          // Skip invisible layers if scanHiddenLayers is turned off
          if (!currentSettings.scanHiddenLayers && 'visible' in node && !node.visible) {
            continue;
          }

          const isText = nodeType === 'TEXT';
          const isShape = !isText;
          const allowColor = (isShape && currentSettings.detectShapeColors !== false) || (isText && currentSettings.detectTextColors !== false);
          const visitedVarIds = new Set();

          // 1. Fast Fill Style Check (supports fillStyleId and legacy backgroundStyleId)
          if (allowColor && currentSettings.detectFills) {
            let fid = null;
            if ('fillStyleId' in node && typeof node.fillStyleId === 'string' && node.fillStyleId.length > 0) {
              fid = node.fillStyleId;
            } else if ('backgroundStyleId' in node && typeof node.backgroundStyleId === 'string' && node.backgroundStyleId.length > 0) {
              fid = node.backgroundStyleId;
            }
            if (fid) {
              let styleInfo = styleCache.get(fid);
              if (styleInfo === undefined) styleInfo = await checkStyle(fid);
              if (styleInfo && styleInfo.isMissing) {
                const key = `fill:${fid}`;
                const previewColor = styleInfo.previewColor || getPreviewColor(node, 'fill', styleInfo);
                const displayName = styleInfo.name || `Remote Color (${previewColor})`;
                addMissingColor(key, fid, 'fill-style', displayName, previewColor, node, page);
              }
            }
          }

          // 2. Fast Stroke Style Check (synchronous cache lookup first)
          if (allowColor && currentSettings.detectStrokes && 'strokeStyleId' in node) {
            const sid = node.strokeStyleId;
            if (typeof sid === 'string' && sid.length > 0) {
              let styleInfo = styleCache.get(sid);
              if (styleInfo === undefined) styleInfo = await checkStyle(sid);
              if (styleInfo && styleInfo.isMissing) {
                const key = `stroke:${sid}`;
                const previewColor = styleInfo.previewColor || getPreviewColor(node, 'stroke', styleInfo);
                const displayName = styleInfo.name || `Remote Stroke (${previewColor})`;
                addMissingColor(key, sid, 'stroke-style', displayName, previewColor, node, page);
              }
            }
          }

          // 3. Complete Bound Variables Check (Colors on Fills, Strokes, Gradients, Backgrounds, ComponentProperties)
          if (allowColor && currentSettings.detectVariables) {
            if ('boundVariables' in node && node.boundVariables) {
              const bv = node.boundVariables;
              // Array fields: fills, strokes, textRangeFills, backgrounds
              const varFields = ['fills', 'strokes', 'textRangeFills', 'backgrounds'];
              for (let f = 0; f < varFields.length; f++) {
                const field = varFields[f];
                if (bv[field]) {
                  const items = Array.isArray(bv[field]) ? bv[field] : [bv[field]];
                  for (let i = 0; i < items.length; i++) {
                    const item = items[i];
                    const varId = typeof item === 'object' && item ? item.id : item;
                    if (varId && typeof varId === 'string' && !visitedVarIds.has(varId)) {
                      visitedVarIds.add(varId);
                      let varInfo = variableCache.get(varId);
                      if (varInfo === undefined) varInfo = await checkVariable(varId);
                      if (varInfo && varInfo.isMissing) {
                        const fieldType = field.includes('stroke') ? 'stroke' : 'fill';
                        const key = `var-${fieldType}:${varId}`;
                        const previewColor = (varInfo && varInfo.previewColor) || getPreviewColor(node, fieldType);
                        const displayName = varInfo.name || `Remote Variable (${previewColor})`;
                        addMissingColor(key, varId, 'variable', displayName, previewColor, node, page);
                      }
                    }
                  }
                }
              }

              // Object map fields: componentProperties
              if (bv.componentProperties && typeof bv.componentProperties === 'object') {
                const propNames = Object.keys(bv.componentProperties);
                for (let p = 0; p < propNames.length; p++) {
                  const propName = propNames[p];
                  const propAlias = bv.componentProperties[propName];
                  const varId = typeof propAlias === 'object' && propAlias ? propAlias.id : propAlias;
                  if (varId && typeof varId === 'string' && !visitedVarIds.has(varId)) {
                    visitedVarIds.add(varId);
                    let varInfo = variableCache.get(varId);
                    if (varInfo === undefined) varInfo = await checkVariable(varId);
                    if (varInfo && varInfo.isMissing) {
                      if (!varInfo.variable || varInfo.variable.resolvedType === 'COLOR' || !varInfo.variable.resolvedType) {
                        const key = `var-prop:${varId}`;
                        const previewColor = (varInfo && varInfo.previewColor) || getPreviewColor(node, 'fill');
                        const displayName = varInfo.name || `${propName} (${previewColor})`;
                        addMissingColor(key, varId, 'variable', displayName, previewColor, node, page);
                      }
                    }
                  }
                }
              }
            }

            // Inspect paints arrays for paint-level boundVariables and gradient stops
            if ('fills' in node && Array.isArray(node.fills)) {
              await checkPaintArrayVariables(node.fills, 'fill', node, page, visitedVarIds, addMissingColor);
            }
            if (currentSettings.detectStrokes && 'strokes' in node && Array.isArray(node.strokes)) {
              await checkPaintArrayVariables(node.strokes, 'stroke', node, page, visitedVarIds, addMissingColor);
            }
            if ('backgrounds' in node && Array.isArray(node.backgrounds)) {
              await checkPaintArrayVariables(node.backgrounds, 'fill', node, page, visitedVarIds, addMissingColor);
            }
          }

          // 4. Fast Text Style & Font Check
          if (isText) {
            // Check uniform textStyleId
            if (currentSettings.detectTextStyles && typeof node.textStyleId === 'string' && node.textStyleId.length > 0) {
              const tid = node.textStyleId;
              let styleInfo = styleCache.get(tid);
              if (styleInfo === undefined) styleInfo = await checkStyle(tid);
              if (styleInfo && styleInfo.isMissing) {
                const key = `text-style:${tid}`;
                const displayName = styleInfo.name || 'Remote Text Style';
                const fontFam = (styleInfo.style && styleInfo.style.fontName && styleInfo.style.fontName !== figma.mixed) ? styleInfo.style.fontName.family : 'Library Text Style';
                const fontSty = (styleInfo.style && styleInfo.style.fontName && styleInfo.style.fontName !== figma.mixed) ? styleInfo.style.fontName.style : '';
                addMissingFont(key, tid, 'text-style', displayName, fontFam, fontSty, node, page);
              }
            }

            // Single unified segment query for mixed styles, mixed variables, and mixed fonts
            const hasMixedFills = allowColor && (
              (currentSettings.detectFills && node.fillStyleId === figma.mixed) ||
              (currentSettings.detectVariables && (node.fills === figma.mixed || (node.boundVariables && node.boundVariables.textRangeFills)))
            );
            const hasMixedTexts = currentSettings.detectTextStyles && node.textStyleId === figma.mixed;
            const hasMissingFont = currentSettings.detectMissingFonts && node.hasMissingFont;
            const hasMixedFonts = hasMissingFont && node.fontName === figma.mixed;

            if ((hasMixedFills || hasMixedTexts || hasMixedFonts) && typeof node.getStyledTextSegments === 'function') {
              const fieldsToFetch = [];
              if (hasMixedFills) {
                fieldsToFetch.push('fillStyleId');
                if (currentSettings.detectVariables) {
                  fieldsToFetch.push('boundVariables');
                  fieldsToFetch.push('fills');
                }
              }
              if (hasMixedTexts) fieldsToFetch.push('textStyleId');
              if (hasMixedFonts) fieldsToFetch.push('fontName');

              try {
                const segments = node.getStyledTextSegments(fieldsToFetch);
                for (let sIdx = 0; sIdx < segments.length; sIdx++) {
                  const seg = segments[sIdx];
                  if (hasMixedFills && typeof seg.fillStyleId === 'string' && seg.fillStyleId.length > 0) {
                    let styleInfo = styleCache.get(seg.fillStyleId);
                    if (styleInfo === undefined) styleInfo = await checkStyle(seg.fillStyleId);
                    if (styleInfo && styleInfo.isMissing) {
                      const key = `fill:${seg.fillStyleId}`;
                      const previewColor = styleInfo.previewColor || getPreviewColor(node, 'fill', styleInfo);
                      const displayName = styleInfo.name || `Remote Color (${previewColor})`;
                      addMissingColor(key, seg.fillStyleId, 'fill-style', displayName, previewColor, node, page);
                    }
                  }
                  if (hasMixedFills && currentSettings.detectVariables) {
                    if (seg.boundVariables) {
                      const segVarFields = ['fills', 'textRangeFills'];
                      for (let sv = 0; sv < segVarFields.length; sv++) {
                        const svField = segVarFields[sv];
                        if (seg.boundVariables[svField]) {
                          const bItems = Array.isArray(seg.boundVariables[svField]) ? seg.boundVariables[svField] : [seg.boundVariables[svField]];
                          for (let b = 0; b < bItems.length; b++) {
                            const bItem = bItems[b];
                            const varId = typeof bItem === 'object' && bItem ? bItem.id : bItem;
                            if (varId && typeof varId === 'string' && !visitedVarIds.has(varId)) {
                              visitedVarIds.add(varId);
                              let varInfo = variableCache.get(varId);
                              if (varInfo === undefined) varInfo = await checkVariable(varId);
                              if (varInfo && varInfo.isMissing) {
                                const key = `var-fill:${varId}`;
                                const previewColor = (varInfo && varInfo.previewColor) || getPreviewColor(node, 'fill');
                                const displayName = varInfo.name || `Remote Variable (${previewColor})`;
                                addMissingColor(key, varId, 'variable', displayName, previewColor, node, page);
                              }
                            }
                          }
                        }
                      }
                    }
                    if (seg.fills && Array.isArray(seg.fills)) {
                      await checkPaintArrayVariables(seg.fills, 'fill', node, page, visitedVarIds, addMissingColor);
                    }
                  }
                  if (hasMixedTexts && typeof seg.textStyleId === 'string' && seg.textStyleId.length > 0) {
                    let styleInfo = styleCache.get(seg.textStyleId);
                    if (styleInfo === undefined) styleInfo = await checkStyle(seg.textStyleId);
                    if (styleInfo && styleInfo.isMissing) {
                      const key = `text-style:${seg.textStyleId}`;
                      const displayName = styleInfo.name || 'Remote Text Style';
                      const fontFam = (styleInfo.style && styleInfo.style.fontName && styleInfo.style.fontName !== figma.mixed) ? styleInfo.style.fontName.family : 'Library Text Style';
                      const fontSty = (styleInfo.style && styleInfo.style.fontName && styleInfo.style.fontName !== figma.mixed) ? styleInfo.style.fontName.style : '';
                      addMissingFont(key, seg.textStyleId, 'text-style', displayName, fontFam, fontSty, node, page);
                    }
                  }
                  if (hasMixedFonts && seg.fontName) {
                    const fontFam = seg.fontName.family;
                    const fontSty = seg.fontName.style;
                    const fontKey = `${fontFam}::${fontSty}`;
                    if (!availableFontSet.has(fontKey)) {
                      const key = `font:${fontKey}`;
                      addMissingFont(key, fontKey, 'missing-font', `${fontFam} (${fontSty})`, fontFam, fontSty, node, page);
                    }
                  }
                }
              } catch (e) { }
            } else if (hasMissingFont) {
              // Uniform font with missing status: direct fast path without segment query
              let fontFam = 'Unknown Missing Font';
              let fontSty = 'Regular';
              if (node.fontName && typeof node.fontName === 'object') {
                fontFam = node.fontName.family || fontFam;
                fontSty = node.fontName.style || fontSty;
              }
              const key = `font:${fontFam}::${fontSty}`;
              addMissingFont(key, key, 'missing-font', `${fontFam} (${fontSty})`, fontFam, fontSty, node, page);
            }
          }

          // 5. Fast Effect Style Check (synchronous cache lookup first)
          if (currentSettings.detectEffects && 'effectStyleId' in node) {
            const eid = node.effectStyleId;
            if (typeof eid === 'string' && eid.length > 0) {
              let styleInfo = styleCache.get(eid);
              if (styleInfo === undefined) styleInfo = await checkStyle(eid);
              if (styleInfo && styleInfo.isMissing) {
                const key = `effect:${eid}`;
                const displayName = styleInfo.name || 'Remote Effect Style';
                addMissingEffect(key, eid, 'effect-style', displayName, node, page);
              }
            }
          }
        } catch (nodeErr) {
          // Safe isolation: single corrupted node never stops the scan
        }
      }

      // Notify UI that this page is completed (if not skipped)
      if (!skippedPages.has(page.id) && !skippedPages.has(pIdx)) {
        figma.ui.postMessage({
          type: 'scan-page-completed',
          pageIndex: pIdx,
          pageName: page.name,
          nodeCount: allNodes.length
        });
      }
    }

    // Broadcast 100% completion before building and sending final results
    if (pagesToScan.length > 0) {
      const lastPage = pagesToScan[pagesToScan.length - 1];
      figma.ui.postMessage({
        type: 'scan-progress',
        currentPageIndex: pagesToScan.length - 1,
        currentPageName: lastPage ? lastPage.name : 'Complete',
        totalPages: pagesToScan.length,
        inspectedLayers: totalScannedNodes,
        totalLayers: totalScannedNodes,
        status: 'Scan complete! Preparing results...',
        percent: 100
      });
      await yieldToEventLoop();
    }
  } catch (scanErr) {
    console.error('Scan error:', scanErr);
  } finally {
    isScanning = false;

    try {
      const colorsList = Array.from(missingColorsMap.values()).map(item => ({
        key: item.key,
        rawId: item.rawId,
        category: item.category,
        subType: item.subType,
        name: item.name,
        previewColor: item.previewColor,
        count: item.nodes.length,
        nodes: item.nodes
      }));

      const fontsList = Array.from(missingFontsMap.values()).map(item => ({
        key: item.key,
        rawId: item.rawId,
        category: item.category,
        subType: item.subType,
        name: item.name,
        fontFamily: item.fontFamily,
        fontStyle: item.fontStyle,
        count: item.nodes.length,
        nodes: item.nodes
      }));

      const effectsList = Array.from(missingEffectsMap.values()).map(item => ({
        key: item.key,
        rawId: item.rawId,
        category: item.category,
        subType: item.subType,
        name: item.name,
        count: item.nodes.length,
        nodes: item.nodes
      }));

      let pagesInfo = [];
      try {
        pagesInfo = figma.root.children.filter(p => p.type === 'PAGE').map(p => ({
          id: p.id,
          name: p.name,
          isCurrent: p.id === figma.currentPage.id
        }));
      } catch (pErr) {
        console.warn('Could not read pagesInfo:', pErr);
      }

      figma.ui.postMessage({
        type: 'scan-results',
        scope,
        settings: currentSettings,
        stats: {
          totalColors: colorsList.reduce((acc, c) => acc + c.count, 0),
          totalFonts: fontsList.reduce((acc, f) => acc + f.count, 0),
          totalEffects: effectsList.reduce((acc, e) => acc + e.count, 0),
          uniqueColors: colorsList.length,
          uniqueFonts: fontsList.length,
          totalScannedNodes
        },
        results: {
          colors: colorsList,
          fonts: fontsList,
          effects: effectsList
        },
        pages: pagesInfo
      });
    } catch (finalErr) {
      console.error('Error broadcasting scan-results:', finalErr);
      try {
        figma.ui.postMessage({
          type: 'scan-results',
          scope,
          settings: currentSettings,
          stats: {
            totalColors: 0,
            totalFonts: 0,
            totalEffects: 0,
            uniqueColors: 0,
            uniqueFonts: 0,
            totalScannedNodes
          },
          results: { colors: [], fonts: [], effects: [] },
          pages: []
        });
      } catch (e) { }
    }
  }
}

// Helper: cleanly switch to another page in dynamic-page mode
async function switchToPage(page) {
  if (!page || page.id === figma.currentPage.id) return;
  if (typeof page.loadAsync === 'function') {
    await page.loadAsync();
  }
  if (typeof figma.setCurrentPageAsync === 'function') {
    await figma.setCurrentPageAsync(page);
  } else {
    figma.currentPage = page;
  }
}

// Focus a single layer (switches page if needed, selects and zooms)
async function focusNode(nodeId, pageId) {
  try {
    let targetPage = null;
    if (pageId) {
      targetPage = figma.root.children.find(p => p.id === pageId);
    }
    if (targetPage) {
      await switchToPage(targetPage);
    }

    const node = await figma.getNodeByIdAsync(nodeId);
    if (!node) {
      figma.notify('Layer not found or may have been deleted.', { error: true });
      return;
    }

    const page = getPageForNode(node);
    if (page) {
      await switchToPage(page);
    }

    figma.currentPage.selection = [node];
    figma.viewport.scrollAndZoomIntoView([node]);
    figma.notify(`Focused layer "${node.name}"`, { timeout: 1500 });
  } catch (err) {
    console.error('Focus error:', err);
    figma.notify('Could not focus layer: ' + err.message, { error: true });
  }
}

// Select multiple nodes on active page
async function selectNodes(nodeIds, pageId) {
  try {
    if (pageId) {
      const targetPage = figma.root.children.find(p => p.id === pageId);
      if (targetPage) {
        await switchToPage(targetPage);
      }
    }

    const validNodes = [];
    for (const id of nodeIds) {
      const node = await figma.getNodeByIdAsync(id);
      if (node && getPageForNode(node).id === figma.currentPage.id) {
        validNodes.push(node);
      }
    }

    if (validNodes.length > 0) {
      figma.currentPage.selection = validNodes;
      figma.viewport.scrollAndZoomIntoView(validNodes);
      figma.notify(`Selected ${validNodes.length} layers`, { timeout: 1500 });
    } else {
      figma.notify('No layers found on current page to select.', { timeout: 1500 });
    }
  } catch (err) {
    console.error('Select error:', err);
    figma.notify('Failed to select layers', { error: true });
  }
}

// Detach/break missing styles or fonts on target nodes
async function breakItem(itemKey, subType, rawId, nodeIds, replacementFont = { family: 'Inter', style: 'Regular' }) {
  let detachedCount = 0;

  if (subType === 'missing-font') {
    try {
      await figma.loadFontAsync(replacementFont);
    } catch (e) {
      try {
        replacementFont = { family: 'Inter', style: 'Regular' };
        await figma.loadFontAsync(replacementFont);
      } catch (err2) {
        figma.notify('Could not load fallback font Inter Regular', { error: true });
        return;
      }
    }
  }

  let styleDef = null;
  if (styleCache.has(rawId)) {
    const cached = styleCache.get(rawId);
    if (cached && cached.style) styleDef = cached.style;
  }
  if (!styleDef && typeof figma.getStyleByIdAsync === 'function') {
    try {
      styleDef = await figma.getStyleByIdAsync(rawId);
    } catch (e) { }
  } else if (!styleDef && typeof figma.getStyleById === 'function') {
    try {
      styleDef = figma.getStyleById(rawId);
    } catch (e) { }
  }

  for (const id of nodeIds) {
    try {
      const node = await figma.getNodeByIdAsync(id);
      if (!node) continue;

      const wasLocked = node.locked;
      if (wasLocked) {
        try { node.locked = false; } catch (e) { }
      }

      if (subType === 'fill-style') {
        if ('fillStyleId' in node) {
          if (node.fillStyleId === rawId) {
            let currentFills = node.fills ? JSON.parse(JSON.stringify(node.fills)) : [];
            if ((!currentFills || currentFills.length === 0) && styleDef && styleDef.paints) {
              currentFills = JSON.parse(JSON.stringify(styleDef.paints));
            }
            await setNodeFillStyleId(node, '');
            if (currentFills && currentFills.length > 0) {
              await setNodeFills(node, currentFills);
            }
            detachedCount++;
          } else if (node.type === 'TEXT' && node.fillStyleId === figma.mixed && typeof node.getStyledTextSegments === 'function') {
            const segments = node.getStyledTextSegments(['fillStyleId']);
            for (const seg of segments) {
              if (seg.fillStyleId === rawId) {
                await setNodeRangeFillStyleId(node, seg.start, seg.end, '');
                detachedCount++;
              }
            }
          }
        }
      } else if (subType === 'stroke-style') {
        if ('strokeStyleId' in node && node.strokeStyleId === rawId) {
          let currentStrokes = node.strokes ? JSON.parse(JSON.stringify(node.strokes)) : [];
          if ((!currentStrokes || currentStrokes.length === 0) && styleDef && styleDef.paints) {
            currentStrokes = JSON.parse(JSON.stringify(styleDef.paints));
          }
          await setNodeStrokeStyleId(node, '');
          if (currentStrokes && currentStrokes.length > 0) {
            await setNodeStrokes(node, currentStrokes);
          }
          detachedCount++;
        }
      } else if (subType === 'variable') {
        try {
          if ('setBoundVariable' in node) {
            try { node.setBoundVariable('fills', null); } catch (e) { }
            try { node.setBoundVariable('strokes', null); } catch (e) { }
          }
          if ('fills' in node && Array.isArray(node.fills)) {
            const newFills = node.fills.map(p => {
              if (p && p.boundVariables && p.boundVariables.color && p.boundVariables.color.id === rawId) {
                const clone = JSON.parse(JSON.stringify(p));
                delete clone.boundVariables.color;
                return clone;
              }
              return p;
            });
            await setNodeFills(node, newFills);
          }
          if ('strokes' in node && Array.isArray(node.strokes)) {
            const newStrokes = node.strokes.map(p => {
              if (p && p.boundVariables && p.boundVariables.color && p.boundVariables.color.id === rawId) {
                const clone = JSON.parse(JSON.stringify(p));
                delete clone.boundVariables.color;
                return clone;
              }
              return p;
            });
            await setNodeStrokes(node, newStrokes);
          }
          detachedCount++;
        } catch (e) { }
      } else if (subType === 'text-style') {
        if (node.type === 'TEXT') {
          if (node.textStyleId === rawId) {
            await setNodeTextStyleId(node, '');
            detachedCount++;
          } else if (node.textStyleId === figma.mixed && typeof node.getStyledTextSegments === 'function') {
            const segments = node.getStyledTextSegments(['textStyleId']);
            for (const seg of segments) {
              if (seg.textStyleId === rawId) {
                await setNodeRangeTextStyleId(node, seg.start, seg.end, '');
                detachedCount++;
              }
            }
          }
        }
      } else if (subType === 'missing-font') {
        if (node.type === 'TEXT') {
          try {
            if (node.fontName !== figma.mixed) {
              await setNodeFontName(node, replacementFont);
              detachedCount++;
            } else if (typeof node.getStyledTextSegments === 'function') {
              const segments = node.getStyledTextSegments(['fontName']);
              for (const seg of segments) {
                const segFontKey = `${seg.fontName.family}::${seg.fontName.style}`;
                if (segFontKey === rawId || node.hasMissingFont) {
                  await setNodeRangeFontName(node, seg.start, seg.end, replacementFont);
                  detachedCount++;
                }
              }
            } else {
              await setNodeFontName(node, replacementFont);
              detachedCount++;
            }
          } catch (e) {
            try {
              await setNodeFontName(node, replacementFont);
              detachedCount++;
            } catch (e2) { }
          }
        }
      } else if (subType === 'effect-style') {
        if ('effectStyleId' in node && node.effectStyleId === rawId) {
          const currentEffects = node.effects ? JSON.parse(JSON.stringify(node.effects)) : [];
          await setNodeEffectStyleId(node, '');
          if (currentEffects && currentEffects.length > 0) {
            await setNodeEffects(node, currentEffects);
          }
          detachedCount++;
        }
      }

      if (wasLocked) {
        try { node.locked = true; } catch (e) { }
      }
    } catch (err) {
      console.error('Error detaching item on node:', id, err);
    }
  }

  return detachedCount;
}

// Bulk break for a whole category
async function breakCategory(category, scope = 'all', replacementFont = { family: 'Inter', style: 'Regular' }) {
  figma.ui.postMessage({
    type: 'scan-progress',
    status: `Breaking all ${category}...`,
    percent: 50
  });

  const pagesToProcess = [];
  if (scope === 'all') {
    for (const page of figma.root.children) {
      if (page.type === 'PAGE') pagesToProcess.push(page);
    }
  } else {
    pagesToProcess.push(figma.currentPage);
  }

  if (category === 'fonts' || category === 'all') {
    try {
      await figma.loadFontAsync(replacementFont);
    } catch (e) {
      replacementFont = { family: 'Inter', style: 'Regular' };
      try {
        await figma.loadFontAsync(replacementFont);
      } catch (e2) { }
    }
  }

  let totalBroken = 0;

  for (const page of pagesToProcess) {
    if (typeof page.loadAsync === 'function') {
      await page.loadAsync();
    }
    const nodes = page.findAll(() => true);

    for (const node of nodes) {
      try {
        const wasLocked = node.locked;
        if (wasLocked) {
          try { node.locked = false; } catch (e) { }
        }

        if (category === 'colors' || category === 'all') {
          if ('fillStyleId' in node && typeof node.fillStyleId === 'string' && node.fillStyleId.length > 0) {
            const styleInfo = await checkStyle(node.fillStyleId);
            if (styleInfo && styleInfo.isMissing) {
              let fills = node.fills ? JSON.parse(JSON.stringify(node.fills)) : [];
              if ((!fills || fills.length === 0) && styleInfo.paints) {
                fills = JSON.parse(JSON.stringify(styleInfo.paints));
              }
              await setNodeFillStyleId(node, '');
              if (fills && fills.length > 0) {
                await setNodeFills(node, fills);
              }
              totalBroken++;
            }
          }
          if ('strokeStyleId' in node && typeof node.strokeStyleId === 'string' && node.strokeStyleId.length > 0) {
            const styleInfo = await checkStyle(node.strokeStyleId);
            if (styleInfo && styleInfo.isMissing) {
              let strokes = node.strokes ? JSON.parse(JSON.stringify(node.strokes)) : [];
              if ((!strokes || strokes.length === 0) && styleInfo.paints) {
                strokes = JSON.parse(JSON.stringify(styleInfo.paints));
              }
              await setNodeStrokeStyleId(node, '');
              if (strokes && strokes.length > 0) {
                await setNodeStrokes(node, strokes);
              }
              totalBroken++;
            }
          }
          if ('setBoundVariable' in node) {
            try {
              if (node.boundVariables && (node.boundVariables.fills || node.boundVariables.strokes)) {
                try { node.setBoundVariable('fills', null); } catch (e) { }
                try { node.setBoundVariable('strokes', null); } catch (e) { }
                totalBroken++;
              }
            } catch (e) { }
          }
        }

        if (category === 'fonts' || category === 'all') {
          if (node.type === 'TEXT') {
            if (typeof node.textStyleId === 'string' && node.textStyleId.length > 0) {
              const styleInfo = await checkStyle(node.textStyleId);
              if (styleInfo && styleInfo.isMissing) {
                await setNodeTextStyleId(node, '');
                totalBroken++;
              }
            }
            if (node.hasMissingFont) {
              try {
                await setNodeFontName(node, replacementFont);
                totalBroken++;
              } catch (e) { }
            }
          }
        }

        if (wasLocked) {
          try { node.locked = true; } catch (e) { }
        }
      } catch (err) { }
    }
  }

}

// Message handler from UI
figma.ui.onmessage = async (msg) => {
  if (!msg || !msg.type) return;

  switch (msg.type) {
    case 'get-settings':
      try {
        const saved = await figma.clientStorage.getAsync('detection-settings');
        if (saved && typeof saved === 'object') {
          currentSettings = { ...defaultSettings, ...saved };
        }
      } catch (e) { }
      figma.ui.postMessage({
        type: 'init-settings',
        settings: currentSettings,
        scope: currentSettings.scope || 'all'
      });
      break;

    case 'scan':
      if (msg.scope) {
        currentSettings.scope = msg.scope;
        try {
          await figma.clientStorage.setAsync('detection-settings', currentSettings);
        } catch (e) { }
      }
      await scanMissingItems(msg.scope || currentSettings.scope || 'all', msg.settings);
      break;

    case 'cancel-scan':
      isScanCancelled = true;
      break;

    case 'toggle-page-skip':
      if (msg.pageId) {
        if (msg.skip) {
          skippedPages.add(msg.pageId);
        } else {
          skippedPages.delete(msg.pageId);
        }
      }
      if (typeof msg.pageIndex === 'number') {
        if (msg.skip) {
          skippedPages.add(msg.pageIndex);
        } else {
          skippedPages.delete(msg.pageIndex);
        }
      }
      if (msg.skip && (msg.pageId === currentPageIdBeingScanned || msg.pageIndex === currentPageIndexBeingScanned)) {
        skipCurrentPage = true;
      }
      break;

    case 'save-settings':
      if (msg.settings && typeof msg.settings === 'object') {
        currentSettings = { ...currentSettings, ...msg.settings };
      }
      if (msg.scope) {
        currentSettings.scope = msg.scope;
      }
      try {
        await figma.clientStorage.setAsync('detection-settings', currentSettings);
      } catch (e) {
        console.error('Failed to save settings:', e);
      }
      if (msg.scan !== false) {
        await scanMissingItems(msg.scope || currentSettings.scope || 'all');
      }
      break;

    case 'focus-node':
      await focusNode(msg.nodeId, msg.pageId);
      break;

    case 'select-nodes':
      await selectNodes(msg.nodeIds || [], msg.pageId);
      break;

    case 'break-item':
      const detachedCount = await breakItem(
        msg.itemKey,
        msg.subType,
        msg.rawId,
        msg.nodeIds || [],
        msg.replacementFont
      );
      figma.ui.postMessage({
        type: 'item-broken',
        itemKey: msg.itemKey,
        nodeIds: msg.nodeIds || [],
        count: detachedCount
      });
      break;

    case 'break-category':
      await breakCategory(msg.category, msg.scope || 'all', msg.replacementFont);
      figma.ui.postMessage({
        type: 'category-broken',
        category: msg.category
      });
      break;

    case 'notify':
      figma.notify(msg.message || '', { error: !!msg.error });
      break;

    case 'resize':
      figma.ui.resize(msg.width || 450, msg.height || 620);
      break;

    case 'close':
      figma.closePlugin();
      break;
  }
};

// Initial launch (loads saved settings without auto-scanning)
(async () => {
  try {
    const saved = await figma.clientStorage.getAsync('detection-settings');
    if (saved && typeof saved === 'object') {
      currentSettings = { ...defaultSettings, ...saved };
    }
  } catch (e) { }

  figma.ui.postMessage({
    type: 'init-settings',
    settings: currentSettings,
    scope: currentSettings.scope || 'all'
  });
})();
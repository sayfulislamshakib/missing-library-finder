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

// Helper: check style status (fetches remote style metadata including color names)
async function checkStyle(styleId) {
  if (!styleId || typeof styleId !== 'string') return null;
  const cacheKey = styleId;
  if (styleCache.has(cacheKey)) {
    return styleCache.get(cacheKey);
  }

  // Look up style asynchronously (official Figma API for local and library styles)
  let style = null;
  if (typeof figma.getStyleByIdAsync === 'function') {
    try {
      style = await figma.getStyleByIdAsync(styleId);
    } catch (e) {
      style = null;
    }
  } else if (typeof figma.getStyleById === 'function') {
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
      paints: null
    };
    styleCache.set(cacheKey, res);
    return res;
  }

  // Local style created in this file -> NOT from an external library
  if (!style.remote) {
    const res = {
      isMissing: false,
      name: style.name,
      rawId: styleId,
      remote: false,
      style: style,
      paints: style.paints || null
    };
    styleCache.set(cacheKey, res);
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
    key: style.key
  };
  styleCache.set(cacheKey, res);
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
  } else if (figma.variables && typeof figma.variables.getVariableById === 'function') {
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
      variable: null
    };
    variableCache.set(cacheKey, res);
    return res;
  }

  if (!variable.remote) {
    const res = {
      isMissing: false,
      name: variable.name,
      rawId: variableId,
      remote: false,
      variable: variable
    };
    variableCache.set(cacheKey, res);
    return res;
  }

  const res = {
    isMissing: true,
    name: variable.name || null,
    rawId: variableId,
    remote: true,
    variable: variable,
    key: variable.key
  };
  variableCache.set(cacheKey, res);
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

// Helper: extract swatch representation
function getPreviewColor(node, type, styleInfo = null) {
  try {
    // 1. Try style definition paints first
    if (styleInfo && styleInfo.paints && Array.isArray(styleInfo.paints) && styleInfo.paints.length > 0) {
      const solid = styleInfo.paints.find(p => p.type === 'SOLID' && p.visible !== false);
      if (solid && solid.color) {
        return rgbToHex(solid.color, solid.opacity);
      }
    }
    // 2. Try node paints
    let paints = [];
    if (type.includes('stroke') && 'strokes' in node && Array.isArray(node.strokes)) {
      paints = node.strokes;
    } else if ('fills' in node && Array.isArray(node.fills)) {
      paints = node.fills;
    }
    const solid = paints.find(p => p.type === 'SOLID' && p.visible !== false);
    if (solid && solid.color) {
      return rgbToHex(solid.color, solid.opacity);
    }
  } catch (e) { }
  return '#A0AEC0';
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

  if (newSettings && typeof newSettings === 'object') {
    currentSettings = { ...currentSettings, ...newSettings };
  }

  styleCache.clear();
  variableCache.clear();

  const missingColorsMap = new Map();
  const missingFontsMap = new Map();
  const missingEffectsMap = new Map();
  let totalScannedNodes = 0;

  try {
    // Pre-index all local styles (avoids triggering remote 403 fetches)
    try {
      const paintStyles = typeof figma.getLocalPaintStylesAsync === 'function'
        ? await figma.getLocalPaintStylesAsync()
        : (figma.getLocalPaintStyles ? figma.getLocalPaintStyles() : []);
      const textStyles = typeof figma.getLocalTextStylesAsync === 'function'
        ? await figma.getLocalTextStylesAsync()
        : (figma.getLocalTextStyles ? figma.getLocalTextStyles() : []);
      const effectStyles = typeof figma.getLocalEffectStylesAsync === 'function'
        ? await figma.getLocalEffectStylesAsync()
        : (figma.getLocalEffectStyles ? figma.getLocalEffectStyles() : []);

      for (const s of [...paintStyles, ...textStyles, ...effectStyles]) {
        if (!s) continue;
        styleCache.set(s.id, {
          isMissing: false,
          name: s.name,
          rawId: s.id,
          remote: false,
          style: s,
          paints: s.paints || null
        });
        if (s.key) {
          styleCache.set(s.key, {
            isMissing: false,
            name: s.name,
            rawId: s.id,
            remote: false,
            style: s,
            paints: s.paints || null
          });
        }
      }
    } catch (e) {
      console.warn('Error pre-indexing local styles:', e);
    }

    // Pre-index all local variables
    if (figma.variables) {
      try {
        const localVars = typeof figma.variables.getLocalVariablesAsync === 'function'
          ? await figma.variables.getLocalVariablesAsync()
          : (figma.variables.getLocalVariables ? figma.variables.getLocalVariables() : []);
        for (const v of localVars) {
          if (!v) continue;
          variableCache.set(v.id, {
            isMissing: false,
            name: v.name,
            rawId: v.id,
            remote: false,
            variable: v
          });
          if (v.key) {
            variableCache.set(v.key, {
              isMissing: false,
              name: v.name,
              rawId: v.id,
              remote: false,
              variable: v
            });
          }
        }
      } catch (e) {
        console.warn('Error pre-indexing local variables:', e);
      }
    }

    const { fonts: availableFontSet } = await getAvailableFontsMap();

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

      totalScannedNodes += allNodes.length;

      for (let nIdx = 0; nIdx < allNodes.length; nIdx++) {
        if (isScanCancelled) break;

        // Yield every 150 nodes to keep UI responsive and report progress
        if (nIdx > 0 && nIdx % 150 === 0) {
          await yieldToEventLoop();
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
          // Skip invisible layers if scanHiddenLayers is turned off
          if (!currentSettings.scanHiddenLayers && 'visible' in node && !node.visible) {
            continue;
          }

          const isText = node.type === 'TEXT';
          const isShape = node.type !== 'TEXT';
          const allowColor = (isShape && currentSettings.detectShapeColors !== false) || (isText && currentSettings.detectTextColors !== false);

          // 1. Check Missing / Remote Fill Style
          if (allowColor && currentSettings.detectFills && 'fillStyleId' in node) {
            if (typeof node.fillStyleId === 'string' && node.fillStyleId.length > 0) {
              const styleInfo = await checkStyle(node.fillStyleId);
              if (styleInfo && styleInfo.isMissing) {
                const key = `fill:${node.fillStyleId}`;
                const previewColor = getPreviewColor(node, 'fill', styleInfo);
                const displayName = (styleInfo && styleInfo.name) ? styleInfo.name : `Remote Color (${previewColor})`;
                if (!missingColorsMap.has(key)) {
                  missingColorsMap.set(key, {
                    key,
                    rawId: node.fillStyleId,
                    category: 'color',
                    subType: 'fill-style',
                    name: displayName,
                    previewColor: previewColor,
                    nodes: []
                  });
                }
                missingColorsMap.get(key).nodes.push({
                  id: node.id,
                  name: node.name || 'Unnamed Layer',
                  type: node.type,
                  pageId: page.id,
                  pageName: page.name
                });
              }
            } else if (node.type === 'TEXT' && node.fillStyleId === figma.mixed && typeof node.getStyledTextSegments === 'function') {
              try {
                const segments = node.getStyledTextSegments(['fillStyleId']);
                for (const seg of segments) {
                  if (typeof seg.fillStyleId === 'string' && seg.fillStyleId.length > 0) {
                    const styleInfo = await checkStyle(seg.fillStyleId);
                    if (styleInfo && styleInfo.isMissing) {
                      const key = `fill:${seg.fillStyleId}`;
                      const previewColor = getPreviewColor(node, 'fill', styleInfo);
                      const displayName = (styleInfo && styleInfo.name) ? styleInfo.name : `Remote Color (${previewColor})`;
                      if (!missingColorsMap.has(key)) {
                        missingColorsMap.set(key, {
                          key,
                          rawId: seg.fillStyleId,
                          category: 'color',
                          subType: 'fill-style',
                          name: displayName,
                          previewColor: previewColor,
                          nodes: []
                        });
                      }
                      const entry = missingColorsMap.get(key);
                      if (!entry.nodes.some(n => n.id === node.id)) {
                        entry.nodes.push({
                          id: node.id,
                          name: node.name || 'Unnamed Layer',
                          type: node.type,
                          pageId: page.id,
                          pageName: page.name
                        });
                      }
                    }
                  }
                }
              } catch (e) { }
            }
          }

          // 2. Check Missing / Remote Stroke Style
          if (allowColor && currentSettings.detectStrokes && 'strokeStyleId' in node && typeof node.strokeStyleId === 'string' && node.strokeStyleId.length > 0) {
            const styleInfo = await checkStyle(node.strokeStyleId);
            if (styleInfo && styleInfo.isMissing) {
              const key = `stroke:${node.strokeStyleId}`;
              const previewColor = getPreviewColor(node, 'stroke', styleInfo);
              const displayName = (styleInfo && styleInfo.name) ? styleInfo.name : `Remote Stroke (${previewColor})`;
              if (!missingColorsMap.has(key)) {
                missingColorsMap.set(key, {
                  key,
                  rawId: node.strokeStyleId,
                  category: 'color',
                  subType: 'stroke-style',
                  name: displayName,
                  previewColor: previewColor,
                  nodes: []
                });
              }
              missingColorsMap.get(key).nodes.push({
                id: node.id,
                name: node.name || 'Unnamed Layer',
                type: node.type,
                pageId: page.id,
                pageName: page.name
              });
            }
          }

          // 3. Check Missing Bound Variables (Colors)
          if (allowColor && currentSettings.detectVariables && 'boundVariables' in node && node.boundVariables) {
            const bv = node.boundVariables;
            if (bv.fills) {
              const fillVars = Array.isArray(bv.fills) ? bv.fills : [bv.fills];
              for (const item of fillVars) {
                const varId = typeof item === 'object' && item ? item.id : item;
                if (varId && typeof varId === 'string') {
                  const varInfo = await checkVariable(varId);
                  if (varInfo && varInfo.isMissing) {
                    const key = `var-fill:${varId}`;
                    const previewColor = getPreviewColor(node, 'fill');
                    const displayName = (varInfo && varInfo.name) ? varInfo.name : `Remote Variable (${previewColor})`;
                    if (!missingColorsMap.has(key)) {
                      missingColorsMap.set(key, {
                        key,
                        rawId: varId,
                        category: 'color',
                        subType: 'variable',
                        name: displayName,
                        previewColor: previewColor,
                        nodes: []
                      });
                    }
                    const entry = missingColorsMap.get(key);
                    if (!entry.nodes.some(n => n.id === node.id)) {
                      entry.nodes.push({
                        id: node.id,
                        name: node.name || 'Unnamed Layer',
                        type: node.type,
                        pageId: page.id,
                        pageName: page.name
                      });
                    }
                  }
                }
              }
            }

            if (bv.strokes) {
              const strokeVars = Array.isArray(bv.strokes) ? bv.strokes : [bv.strokes];
              for (const item of strokeVars) {
                const varId = typeof item === 'object' && item ? item.id : item;
                if (varId && typeof varId === 'string') {
                  const varInfo = await checkVariable(varId);
                  if (varInfo && varInfo.isMissing) {
                    const key = `var-stroke:${varId}`;
                    const previewColor = getPreviewColor(node, 'stroke');
                    const displayName = (varInfo && varInfo.name) ? varInfo.name : `Remote Variable (${previewColor})`;
                    if (!missingColorsMap.has(key)) {
                      missingColorsMap.set(key, {
                        key,
                        rawId: varId,
                        category: 'color',
                        subType: 'variable',
                        name: displayName,
                        previewColor: previewColor,
                        nodes: []
                      });
                    }
                    const entry = missingColorsMap.get(key);
                    if (!entry.nodes.some(n => n.id === node.id)) {
                      entry.nodes.push({
                        id: node.id,
                        name: node.name || 'Unnamed Layer',
                        type: node.type,
                        pageId: page.id,
                        pageName: page.name
                      });
                    }
                  }
                }
              }
            }
          }

          // Check paint-level boundVariables
          if (allowColor && currentSettings.detectVariables && 'fills' in node && Array.isArray(node.fills)) {
            for (const paint of node.fills) {
              if (paint && paint.boundVariables && paint.boundVariables.color) {
                const varId = paint.boundVariables.color.id;
                if (varId) {
                  const varInfo = await checkVariable(varId);
                  if (varInfo && varInfo.isMissing) {
                    const key = `var-paint:${varId}`;
                    const previewColor = getPreviewColor(node, 'fill');
                    const displayName = (varInfo && varInfo.name) ? varInfo.name : `Remote Variable (${previewColor})`;
                    if (!missingColorsMap.has(key)) {
                      missingColorsMap.set(key, {
                        key,
                        rawId: varId,
                        category: 'color',
                        subType: 'variable',
                        name: displayName,
                        previewColor: previewColor,
                        nodes: []
                      });
                    }
                    const entry = missingColorsMap.get(key);
                    if (!entry.nodes.some(n => n.id === node.id)) {
                      entry.nodes.push({
                        id: node.id,
                        name: node.name || 'Unnamed Layer',
                        type: node.type,
                        pageId: page.id,
                        pageName: page.name
                      });
                    }
                  }
                }
              }
            }
          }

          // 4. Check Missing Typography / Text Styles
          if (currentSettings.detectTextStyles && node.type === 'TEXT') {
            if (typeof node.textStyleId === 'string' && node.textStyleId.length > 0) {
              const styleInfo = await checkStyle(node.textStyleId);
              if (styleInfo && styleInfo.isMissing) {
                const key = `text-style:${node.textStyleId}`;
                const displayName = (styleInfo && styleInfo.name) ? styleInfo.name : 'Remote Text Style';
                if (!missingFontsMap.has(key)) {
                  missingFontsMap.set(key, {
                    key,
                    rawId: node.textStyleId,
                    category: 'font',
                    subType: 'text-style',
                    name: displayName,
                    fontFamily: (styleInfo && styleInfo.style && styleInfo.style.fontName) ? styleInfo.style.fontName.family : 'Library Text Style',
                    fontStyle: (styleInfo && styleInfo.style && styleInfo.style.fontName) ? styleInfo.style.fontName.style : '',
                    nodes: []
                  });
                }
                missingFontsMap.get(key).nodes.push({
                  id: node.id,
                  name: node.name || 'Unnamed Text',
                  type: node.type,
                  pageId: page.id,
                  pageName: page.name
                });
              }
            } else if (node.textStyleId === figma.mixed && typeof node.getStyledTextSegments === 'function') {
              try {
                const segments = node.getStyledTextSegments(['textStyleId']);
                for (const seg of segments) {
                  if (typeof seg.textStyleId === 'string' && seg.textStyleId.length > 0) {
                    const styleInfo = await checkStyle(seg.textStyleId);
                    if (styleInfo && styleInfo.isMissing) {
                      const key = `text-style:${seg.textStyleId}`;
                      const displayName = (styleInfo && styleInfo.name) ? styleInfo.name : 'Remote Text Style';
                      if (!missingFontsMap.has(key)) {
                        missingFontsMap.set(key, {
                          key,
                          rawId: seg.textStyleId,
                          category: 'font',
                          subType: 'text-style',
                          name: displayName,
                          fontFamily: (styleInfo && styleInfo.style && styleInfo.style.fontName) ? styleInfo.style.fontName.family : 'Library Text Style',
                          fontStyle: (styleInfo && styleInfo.style && styleInfo.style.fontName) ? styleInfo.style.fontName.style : '',
                          nodes: []
                        });
                      }
                      const entry = missingFontsMap.get(key);
                      if (!entry.nodes.some(n => n.id === node.id)) {
                        entry.nodes.push({
                          id: node.id,
                          name: node.name || 'Unnamed Text',
                          type: node.type,
                          pageId: page.id,
                          pageName: page.name
                        });
                      }
                    }
                  }
                }
              } catch (e) { }
            }

            // 5. Check Missing Fonts (hasMissingFont)
            if (currentSettings.detectMissingFonts && node.hasMissingFont) {
              let foundSegmentFont = false;
              if (typeof node.getStyledTextSegments === 'function') {
                try {
                  const segments = node.getStyledTextSegments(['fontName']);
                  for (const seg of segments) {
                    if (seg.fontName) {
                      const fontFam = seg.fontName.family;
                      const fontSty = seg.fontName.style;
                      const fontKey = `${fontFam}::${fontSty}`;
                      const isMissing = !availableFontSet.has(fontKey);

                      if (isMissing || node.hasMissingFont) {
                        foundSegmentFont = true;
                        const key = `font:${fontFam}::${fontSty}`;
                        if (!missingFontsMap.has(key)) {
                          missingFontsMap.set(key, {
                            key,
                            rawId: fontKey,
                            category: 'font',
                            subType: 'missing-font',
                            name: `${fontFam} (${fontSty})`,
                            fontFamily: fontFam,
                            fontStyle: fontSty,
                            nodes: []
                          });
                        }
                        const entry = missingFontsMap.get(key);
                        if (!entry.nodes.some(n => n.id === node.id)) {
                          entry.nodes.push({
                            id: node.id,
                            name: node.name || 'Unnamed Text',
                            type: node.type,
                            pageId: page.id,
                            pageName: page.name
                          });
                        }
                      }
                    }
                  }
                } catch (e) { }
              }

              if (!foundSegmentFont) {
                let fontFam = 'Unknown Missing Font';
                let fontSty = 'Regular';
                if (node.fontName && node.fontName !== figma.mixed) {
                  fontFam = node.fontName.family;
                  fontSty = node.fontName.style;
                }
                const key = `font:${fontFam}::${fontSty}`;
                if (!missingFontsMap.has(key)) {
                  missingFontsMap.set(key, {
                    key,
                    rawId: key,
                    category: 'font',
                    subType: 'missing-font',
                    name: `${fontFam} (${fontSty})`,
                    fontFamily: fontFam,
                    fontStyle: fontSty,
                    nodes: []
                  });
                }
                const entry = missingFontsMap.get(key);
                if (!entry.nodes.some(n => n.id === node.id)) {
                  entry.nodes.push({
                    id: node.id,
                    name: node.name || 'Unnamed Text',
                    type: node.type,
                    pageId: page.id,
                    pageName: page.name
                  });
                }
              }
            }
          }

          // 6. Check Missing Effect Styles
          if (currentSettings.detectEffects && 'effectStyleId' in node && typeof node.effectStyleId === 'string' && node.effectStyleId.length > 0) {
            const styleInfo = await checkStyle(node.effectStyleId);
            if (styleInfo && styleInfo.isMissing) {
              const key = `effect:${node.effectStyleId}`;
              const displayName = (styleInfo && styleInfo.name) ? styleInfo.name : 'Remote Effect Style';
              if (!missingEffectsMap.has(key)) {
                missingEffectsMap.set(key, {
                  key,
                  rawId: node.effectStyleId,
                  category: 'effect',
                  subType: 'effect-style',
                  name: displayName,
                  nodes: []
                });
              }
              missingEffectsMap.get(key).nodes.push({
                id: node.id,
                name: node.name || 'Unnamed Layer',
                type: node.type,
                pageId: page.id,
                pageName: page.name
              });
            }
          }
        } catch (nodeErr) {
          // Safe isolation: single corrupted node never stops the scan
        }
      }

      // Notify UI that this page is completed
      figma.ui.postMessage({
        type: 'scan-page-completed',
        pageIndex: pIdx,
        pageName: page.name,
        nodeCount: allNodes.length
      });
    }
  } catch (scanErr) {
    console.error('Scan error:', scanErr);
  } finally {
    isScanning = false;

    const colorsList = Array.from(missingColorsMap.values()).map(item => ({
      ...item,
      count: item.nodes.length
    }));

    const fontsList = Array.from(missingFontsMap.values()).map(item => ({
      ...item,
      count: item.nodes.length
    }));

    const effectsList = Array.from(missingEffectsMap.values()).map(item => ({
      ...item,
      count: item.nodes.length
    }));

    const pagesInfo = figma.root.children.filter(p => p.type === 'PAGE').map(p => ({
      id: p.id,
      name: p.name,
      isCurrent: p.id === figma.currentPage.id
    }));

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
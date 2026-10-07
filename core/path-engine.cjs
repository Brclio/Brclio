/* Brclio Toolbox — shared path text formatter. No filesystem or shell access. */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BrclioPath = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var DEFAULT_SETTINGS = Object.freeze({
    pathMode: 'absolute',
    basePath: '',
    quoteMode: 'none',
    separator: 'native',
    trailingSlash: false,
    joinWith: 'newline',
    launchAtLogin: false
  });

  var CONTROLS = /[\u0000-\u001f\u007f-\u009f]/;
  var URI_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
  // These are text wrappers, not shell escaping. Literal quotes are preserved.
  var AUTO_QUOTE = /[\s"'`$&;|<>()[\]{}*?!#]/;

  function fail(code, message) {
    var error = new Error(message);
    error.code = 'BRCLIO_PATH_' + code;
    throw error;
  }

  function enumValue(value, allowed, fallback) {
    return allowed.indexOf(value) === -1 ? fallback : value;
  }

  function normalizeSettings(settings) {
    var source = settings && typeof settings === 'object' ? settings : {};
    return {
      pathMode: enumValue(source.pathMode, ['absolute', 'relative'], DEFAULT_SETTINGS.pathMode),
      basePath: typeof source.basePath === 'string' ? source.basePath : DEFAULT_SETTINGS.basePath,
      quoteMode: enumValue(source.quoteMode, ['none', 'double', 'single', 'auto'], DEFAULT_SETTINGS.quoteMode),
      separator: enumValue(source.separator, ['native', 'forward', 'backward'], DEFAULT_SETTINGS.separator),
      trailingSlash: source.trailingSlash === true,
      joinWith: enumValue(source.joinWith, ['newline', 'space', 'comma'], DEFAULT_SETTINGS.joinWith),
      launchAtLogin: source.launchAtLogin === true
    };
  }

  function validateText(value, label) {
    if (typeof value !== 'string' || value.length === 0) {
      fail('EMPTY', label + '不能为空。');
    }
    if (CONTROLS.test(value)) {
      fail('CONTROL_CHARACTER', label + '包含换行、制表符或其他控制字符，无法复制。');
    }
    return value;
  }

  function normalizeParts(parts) {
    var result = [];
    parts.forEach(function (part) {
      if (!part || part === '.') return;
      if (part === '..') {
        // Absolute paths never traverse above their own drive/share/root.
        if (result.length) result.pop();
      } else result.push(part);
    });
    return result;
  }

  function parsePath(value, label) {
    validateText(value, label || '路径');
    // A drive with repeated forward separators (C://folder) is still a
    // Windows path, even though its prefix resembles a one-letter URI scheme.
    if (URI_SCHEME.test(value) && !/^[a-z]:[\\/]/i.test(value)) return { style: 'uri', original: value };

    // Win32 extended-length paths are kept in their explicit namespace.
    var extendedDrive = /^\\\\\?\\([a-z]):[\\/](.*)$/i.exec(value);
    if (extendedDrive) {
      return {
        style: 'windows',
        rootKind: 'extended-drive',
        root: [extendedDrive[1] + ':'],
        rootKey: 'drive:' + extendedDrive[1].toLowerCase(),
        parts: normalizeParts(extendedDrive[2].split(/[\\/]+/))
      };
    }
    var extendedUNC = /^\\\\\?\\UNC[\\/]([^\\/]+)[\\/]([^\\/]+)(?:[\\/](.*))?$/i.exec(value);
    if (extendedUNC) {
      return {
        style: 'windows',
        rootKind: 'extended-unc',
        root: [extendedUNC[1], extendedUNC[2]],
        rootKey: 'unc:' + extendedUNC[1].toLowerCase() + '/' + extendedUNC[2].toLowerCase(),
        parts: normalizeParts((extendedUNC[3] || '').split(/[\\/]+/))
      };
    }

    var drive = /^([a-z]):[\\/](.*)$/i.exec(value);
    if (drive) {
      return {
        style: 'windows',
        rootKind: 'drive',
        root: [drive[1] + ':'],
        rootKey: 'drive:' + drive[1].toLowerCase(),
        parts: normalizeParts(drive[2].split(/[\\/]+/))
      };
    }

    // A double leading separator denotes a UNC share. Three leading POSIX
    // slashes are treated as a repeated POSIX root separator instead.
    if (/^\\\\/.test(value) || /^\/\/[^/]/.test(value)) {
      var unc = /^[\\/]{2}([^\\/]+)[\\/]([^\\/]+)(?:[\\/](.*))?$/.exec(value);
      if (!unc || unc[1] === '.' || unc[1] === '..' || unc[2] === '.' || unc[2] === '..') {
        fail('INVALID_UNC', '网络路径需要完整的服务器名和共享名，例如 \\\\server\\share\\folder。');
      }
      return {
        style: 'windows',
        rootKind: 'unc',
        root: [unc[1], unc[2]],
        rootKey: 'unc:' + unc[1].toLowerCase() + '/' + unc[2].toLowerCase(),
        parts: normalizeParts((unc[3] || '').split(/[\\/]+/))
      };
    }
    if (value.charAt(0) === '/') {
      return { style: 'posix', rootKind: 'posix', rootKey: '/', root: [], parts: normalizeParts(value.split('/')) };
    }
    fail('NOT_ABSOLUTE', (label || '路径') + '必须是绝对路径；请选择文件或文件夹，或输入完整路径。');
  }

  function delimiterFor(parsed, settings) {
    if (settings.separator === 'forward') return '/';
    if (settings.separator === 'backward') return '\\';
    return parsed.style === 'windows' ? '\\' : '/';
  }

  function rootText(parsed, delimiter) {
    switch (parsed.rootKind) {
      case 'drive': return parsed.root[0] + delimiter;
      case 'extended-drive': return delimiter + delimiter + '?' + delimiter + parsed.root[0] + delimiter;
      case 'unc': return delimiter + delimiter + parsed.root.join(delimiter) + delimiter;
      case 'extended-unc': return delimiter + delimiter + '?' + delimiter + 'UNC' + delimiter + parsed.root.join(delimiter) + delimiter;
      default: return delimiter;
    }
  }

  function relativeParts(target, base) {
    if (target.style !== base.style || target.rootKey !== base.rootKey) {
      fail('CROSS_ROOT', '无法跨磁盘、网络共享或文件系统生成相对路径，请选择同一位置的参考目录。');
    }
    var common = 0;
    while (common < target.parts.length && common < base.parts.length) {
      var targetPart = target.parts[common];
      var basePart = base.parts[common];
      if (target.style === 'windows') {
        targetPart = targetPart.toLowerCase();
        basePart = basePart.toLowerCase();
      }
      if (targetPart !== basePart) break;
      common += 1;
    }
    var parts = [];
    for (var i = common; i < base.parts.length; i += 1) parts.push('..');
    return parts.concat(target.parts.slice(common));
  }

  function wrapText(value, quoteMode) {
    if (quoteMode === 'double' || (quoteMode === 'auto' && AUTO_QUOTE.test(value))) return '"' + value + '"';
    if (quoteMode === 'single') return "'" + value + "'";
    return value;
  }

  function formatPath(input, settings) {
    var options = normalizeSettings(settings);
    var entry = typeof input === 'string' ? { path: input } : input;
    if (!entry || typeof entry !== 'object') fail('INVALID_INPUT', '请选择有效的文件或文件夹路径。');
    var parsed = parsePath(entry.path, '路径');
    if (entry.isUri === true && parsed.style !== 'uri') fail('INVALID_URI', '文件提供方返回的 URI 无效，请重新选择文件。');

    if (parsed.style === 'uri') {
      if (options.pathMode === 'relative') {
        fail('URI_RELATIVE', '此文件由 Android 文件提供方提供，仅有内容 URI，无法生成文件系统相对路径。');
      }
      // Content-provider URIs are identifiers, not filesystem paths. Preserve
      // their encoding and separators; never invent an absolute local path.
      return wrapText(parsed.original, options.quoteMode);
    }

    var delimiter = delimiterFor(parsed, options);
    var value;
    if (options.pathMode === 'relative') {
      if (!options.basePath) fail('BASE_REQUIRED', '生成相对路径前，请先设置一个绝对路径作为参考目录。');
      var base = parsePath(options.basePath, '参考目录');
      if (base.style === 'uri') fail('URI_BASE', '内容 URI 不能作为参考目录，请设置文件系统中的绝对目录路径。');
      var parts = relativeParts(parsed, base);
      value = parts.length ? parts.join(delimiter) : '.';
    } else {
      value = rootText(parsed, delimiter) + parsed.parts.join(delimiter);
    }

    if (options.trailingSlash && entry.kind === 'directory' && value.slice(-1) !== delimiter) value += delimiter;
    return wrapText(value, options.quoteMode);
  }

  function formatPaths(paths, settings) {
    if (!Array.isArray(paths)) fail('INVALID_INPUT', '路径列表必须是数组。');
    var options = normalizeSettings(settings);
    var joiner = options.joinWith === 'space' ? ' ' : options.joinWith === 'comma' ? ', ' : '\n';
    return paths.map(function (entry, index) {
      try {
        return formatPath(entry, options);
      } catch (error) {
        var contextual = new Error('第 ' + (index + 1) + ' 个路径：' + error.message);
        contextual.code = error.code;
        contextual.pathIndex = index;
        throw contextual;
      }
    }).join(joiner);
  }

  return Object.freeze({
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    normalizeSettings: normalizeSettings,
    formatPath: formatPath,
    formatPaths: formatPaths
  });
});

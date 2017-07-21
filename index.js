var fs          = require('fs');
var path        = require("path");
var parse5      = require('parse5');
var gutil       = require('gulp-util');
var through     = require("through2");
var sass        = require("node-sass");
var PLUGIN_NAME = 'gulp-vue-module';
var LOG_PREFIX  = '[' + PLUGIN_NAME + '] ';

function getAttribute (node, name) {
    if (node.attrs) {
        var i = node.attrs.length, attr;

        while (i--) {
            attr = node.attrs[i];
            if (attr.name === name) {
                return attr.value;
            }
        }
    }
}

function getRequire (str) {
    var reg = new RegExp('require\\s*\\(\\s*[\'\"](\\S+)[\'\"]\\s*\\)', 'g');
    var arr = reg.exec(str);
    var oRequire = {};

    while (arr) {
        oRequire[arr[1]] = 1;
        arr = reg.exec(str);
    }

    return Object.keys(oRequire).join(',');
}

module.exports = function(options) {
    var defaults = {
        debug              : false,               // Debug mode
        amd                : false,               // AMD style, Define module name and deps
        define             : true,                // Using define() wrapper the module, false for Node.js (CommonJS style)
        defineName         : false,               // Define the module name
        indent             : '    ',              // Indent whitespace
        headerComment      : true,                // Using <header-comment> Insert the header comments
        templateReplaceTag : '__template__', // vue component template replace tag
        loadCSSMethod      : 'require.loadCSS'    // define the load css method for require
    };

    var settings = Object.assign({}, defaults, options),
        debug    = settings.debug,
        indent   = settings.indent,
        templateReplaceTag = settings.templateReplaceTag;
    
     return through.obj(function (file, encoding, callback) {
        if (file.isNull()) {
            return callback(null, file);
        }

        if (file.isStream()) {
            this.emit('error', new gutil.PluginError(PLUGIN_NAME, 'Cannot use streamed files'));
            return callback();
        }

        if (file.isBuffer()) {
            if (debug) {
                console.log(LOG_PREFIX, "target =>", file.path);
            }
            
            var content  = file.contents.toString(encoding),
                fragment = parse5.parseFragment(content, {
                    locationInfo: true
                });
            
            var tags     = {}, 
                contents = {
                    script   : [],
                    style    : [],
                    template : []
                },
                moduleName      = '',
                moduleDeps      = '',
                headerComment   = '',
                includeFileName,
                scriptEmpty     = false,
                componentTags   = ['template', 'style', 'script'];

            fragment.childNodes.forEach(function (node) {
                var type = node.tagName;
                var lang = getAttribute(node, 'lang');
                var href = getAttribute(node, 'href');
                var src  = getAttribute(node, 'src');
                
                if (type === "header-comment") {
                    headerComment = parse5.serialize(node);
                }
                
                if (componentTags.indexOf(type) >= 0) {
                    tags[type] = true;
                    
                    if (type === "style") {
                        var style = parse5.serialize(node);
                        // style is empty
                        if (!style.trim()) return;

                        if (!lang || lang === "css") {
                            style.split("\n").forEach(function(line){
                                if (line) contents.style.push(line.trim());
                            });
                            
                            style = contents.style.join("");
                            
                            if (style != "") {
                                contents.style = '{content : "' + style + '"}';
                            }

                            if (href && href !== "") {
                                contents.style = '{url : "' + href + '"}';
                            }
                        }
                        else if (lang && (lang === "sass" || lang === "scss")) {
                            contents.style = [];

                            style.split("\n").forEach(function(line){
                                if (line) contents.style.push(line);
                            });
                            
                            var result,
                                sassRenderOptions = {
                                    outputStyle    : "compressed",
                                    indentedSyntax : (lang === "sass") ? true : false,
                                };

                            if (href) {
                                sassRenderOptions.file = href;
                            } else {
                                sassRenderOptions.data = contents.style.join("\n");
                            }

                            result = sass.renderSync(sassRenderOptions);
                            result = result.css.toString().replace("\n", "");

                            if (result !== "") {
                                contents.style = '{content : "' + result + '"}';
                            }
                        }
                    }
                    
                    if (type === "template") {
                        includeFileName = getAttribute(node, 'include');

                        if (includeFileName) {
                            var tpl = fs.readFileSync(includeFileName, 'utf-8');
                            
                            if (!tpl) {
                                console.error(LOG_PREFIX, "read template file error =>", includeFileName);
                            }
                        } else {
                            var treeAdapter = parse5.treeAdapters.default,
                                docFragment = treeAdapter.createDocumentFragment();

                            treeAdapter.appendChild(docFragment, node);

                            var tpl = parse5.serialize(docFragment);
                            tpl = tpl.replace(/<\/?template>/g, '');
                        }
                        // 分离tpl
                        var oTpl = parse5.parseFragment(tpl, {
                            treeAdapter: parse5.treeAdapters.htmlparser2
                        });

                        var oTpl1 = {};

                        oTpl.children.forEach(function(child) {
                            if (child.type == 'tag') {
                                var key = child.attribs.id || child.attribs.name;
                                var _tpl = parse5.serialize({children: [child]}, {
                                                treeAdapter: parse5.treeAdapters.htmlparser2
                                            });
                                var _aTpl = []
                                _tpl.split("\n").forEach(function(line){
                                    if (line) _aTpl.push(line.trim());
                                });

                                oTpl1[key] = _aTpl.join("").toString().replace(/'/g, "&#39;");
                            }
                        });

                        var _template;
                        // 只有一个时直接是字符串
                        if (Object.keys(oTpl1).length == 1) {
                            _template = '\'' + oTpl1[Object.keys(oTpl1)[0]] + '\'';
                        } else {
                            _template = JSON.stringify(oTpl1, null, indent);
                        }

                        contents.template = _template;
                    }
                    
                    if (type === "script") {
                        var script = parse5.serialize(node);

                        moduleName  = getAttribute(node, 'module-name') ||
                                        // getFileName
                                        path.basename(file.path, path.extname(file.path));
                        moduleDeps  = getAttribute(node, 'module-deps') ||
                                        getRequire(script);

                        if (!/exports/.test(script)) {
                            scriptEmpty = true;
                            script      += indent + "module.exports = {\n" + indent + "};\n";
                        }
                        
                        script.split("\n").forEach(function(line){
                            if (line.trim() != "") {
                                if (/(\s*)module\.exports\s*=\s*{/.test(line) && contents.template) {
                                    // RegExp.$1  indent of module
                                    line = '\n' + line;
                                    line += '\n' + RegExp.$1 + indent + "template: " + templateReplaceTag + ",";
                                }
                                contents.script.push(indent + line);
                            }
                        });
                    }
                }
            });
            // only stcript
            if (!tags.script && !tags.template && !tags.style) {
                tags.script = true;
                var script = file.contents.toString();
                moduleName  = path.basename(file.path, path.extname(file.path));
                moduleDeps  = getRequire(script);

                if (!/exports/.test(script)) {
                    scriptEmpty = true;
                    script      += indent + "module.exports = {\n" + indent + "};\n";
                }
                
                script.split("\n").forEach(function(line){
                    if (line.trim() != "") {
                        if (/(\s*)module\.exports\s*=\s*{/.test(line) && contents.template) {
                            // RegExp.$1  indent of module
                            line = '\n' + line;
                        }
                        contents.script.push(indent + line);
                    }
                });
            }

            if (settings.headerComment) {
                headerComment = headerComment.replace("\n", '');
            } else {
                headerComment = '';
            }
            
            var script        = contents.script.join("\n"), 
                deps          = '', 
                loadCSS       = '', 
                loadTPL       = '', 
                defineName    = '',
                moduleContent = '';
            
            if (typeof contents.style === "string" && contents.style != "") {
                loadCSS = indent + settings.loadCSSMethod + '('+contents.style+');\n\n';
            }
            if (typeof contents.template === "string") {
                loadTPL = indent + 'var ' + settings.templateReplaceTag + ' = '+contents.template+';\n\n';
            }
            
            if (settings.defineName && moduleName) {
                defineName = '\'' + moduleName + '\', ';
            }
            
            if (settings.amd && moduleDeps) {
                deps = [];

                moduleDeps.split(/\s*,\s*/).forEach(function(dep){
                    deps.push('\'' + dep + '\'');
                });
                
                deps = "[" + deps.join(", ") + "], ";
            }
            
            if (settings.define) {
                moduleContent = 'define(' + defineName + deps + 'function(require, exports, module) {\n' + loadCSS + loadTPL + script+'\n});';
            } else {
                moduleContent = script;
            }

            script = headerComment + moduleContent;
            
            content = script;
            
            if (!tags.script) {
                this.emit('error', new gutil.PluginError(PLUGIN_NAME, file.path + ' not vue component file, not have script and template tag'));
                return callback();
            }

            file.contents = new Buffer(content);
        }
        
        callback(null, file);
    });
}
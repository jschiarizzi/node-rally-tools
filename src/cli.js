require("source-map-support").install();

import argparse from "minimist";
import * as allIndexBundle from "./index.js"
import {
    rallyFunctions as funcs,
    Preset, Rule, SupplyChain, Provider, Asset, User, Tag,
    AbortError, UnconfiguredEnvError, Collection, APIError,
} from "./index.js";

import {version as packageVersion} from "../package.json";
import {configFile, configObject, loadConfig} from "./config.js";
import {readFileSync, writeFileSync} from "fs";

import {printOutLine, parseTrace} from "./trace.js";

import {helpText, arg, param, usage, helpEntries, spawn} from "./decorators.js";

import baseCode from "./baseCode.js";
import {sep as pathSeperator} from "path";

import moment from "moment";

import * as configHelpers from "./config-create.js";
const False = false; const True = true; const None = null;

let argv = argparse(process.argv.slice(2), {
    string: ["file", "env"],
    //boolean: ["no-protect"],
    boolean: ["anon"],
    default: {protect: true},
    alias: {
        f: "file", e: "env",
    }
});

//help menu helper
function printHelp(help, short){
    let helpText = chalk`
{white ${help.name}}: ${help.text}
    Usage: ${help.usage || "<unknown>"}
`
    //Trim newlines
    helpText = helpText.substring(1, helpText.length-1);

    if(!short){
        for(let param of help.params || []){
            helpText += chalk`\n    {blue ${param.param}}: ${param.desc}`
        }
        for(let arg of help.args || []){
            helpText += chalk`\n    {blue ${arg.short}}, {blue ${arg.long}}: ${arg.desc}`
        }
    }

    return helpText;
}

async function getFilesFromArgs(args){
    let lastArg = args._.shift()
    if(args.file){
        let files = args.file;
        if(typeof files === "string") files = [files];
        return files;
    }

    if(lastArg == "-"){
        log("Reading from stdin");
        let getStdin = require("get-stdin");
        let stdin = await getStdin();
        let files  = stdin.split("\n");
        if(files[files.length - 1] === "") files.pop();
        return files;
    }else{
        args._.push(lastArg);
    }
}

let presetsub = {
    async before(args){
        this.env = args.env;
        if(!this.env) throw new AbortError("No env supplied");

        this.files = await getFilesFromArgs(args);
    },
    async $grab(args){
        if(!this.files){
            throw new AbortError("No files provided to grab (use --file argument)");
        }

        log(chalk`Grabbing {green ${this.files.length}} preset(s) metadata from {green ${this.env}}.`);

        let presets = this.files.map(path => new Preset({path, remote: false}));
        for(let preset of presets){
            //TODO small refactor
            await preset.grabMetadata(this.env);
            await preset.saveLocalMetadata();

            if(args.full){
                let remo = await Preset.getByName(this.env, preset.name);
                await remo.resolve();
                await remo.downloadCode();
                await remo.saveLocalFile();
            }
        }
    },
    async $create(args){
        let provider, name, ext;
        if(args.provider){
            provider = {name: args.provider};
            ext = args.ext
        }else{
            provider = await configHelpers.selectProvider(await Provider.getAll(this.env));
            ext = (await provider.getEditorConfig()).fileExt;
        }
        if(args.name){
            name = args.name;
        }else{
            name = await configHelpers.askInput("Preset Name", "What is the preset name?");
        }

        let preset = new Preset({subProject: configObject.project});

        preset.providerType = {name: provider.name};
        preset.isGeneric = true;
        preset.name = name;
        preset.ext = ext;
        if(baseCode[provider.name]){
            preset._code = baseCode[provider.name].replace("{name}", name);
        }else{
            preset._code = " ";
        }

        preset.saveLocalMetadata();
        preset.saveLocalFile();
    },
    async $list(args){
        log("Loading...");
        let presets = await Preset.getAll(this.env);
        if(args.resolve){
            Provider.getAll(this.env);
            for(let preset of presets){
                let resolve = await preset.resolve(this.env);
                if(args.attach){
                    let {proType} = resolve;
                    proType.editorConfig.helpText = "";
                    preset.meta = {
                        ...preset.meta, proType
                    };
                }
            }
        }
        if(configObject.rawOutput) return presets;
        log(chalk`{yellow ${presets.length}} presets on {green ${this.env}}.`);
        presets.arr.sort((a, b) => {
            return Number(a.attributes.updatedAt) - Number(b.attributes.updatedAt)
        });
        for(let preset of presets){
            log(preset.chalkPrint());
        }
    },
    async $upload(args){
        if(!this.files){
            throw new AbortError("No files provided to upload (use --file argument)");
        }

        log(chalk`Uploading {green ${this.files.length}} preset(s) to {green ${this.env}}.`);

        let presets = this.files.map(path => new Preset({path, remote: false}));
        await funcs.uploadPresets(this.env, presets);
    },
    async $diff(args){
        let file = this.files[0];
        if(!this.files){
            throw new AbortError("No files provided to diff (use --file argument)");
        }

        let preset = new Preset({path: file, remote: false});
        if(!preset.name){
            throw new AbortError(chalk`No preset header found. Cannot get name.`);
        }
        let preset2 = await Preset.getByName(this.env, preset.name);
        if(!preset2){
            throw new AbortError(chalk`No preset found with name {red ${preset.name}} on {blue ${this.env}}`);
        }
        await preset2.downloadCode();

        let tempfile = require("tempy").file;
        let temp = tempfile({extension: `${this.env}.${preset.ext}`});
        writeFileSync(temp, preset2.code);

        let ptr = `${file},${temp}`;


        //raw output returns "file1" "file2"
        if(configObject.rawOutput){
            if(args["only-new"]) return temp;
            else return ptr;
        }

        //standard diff
        argv.command = argv.command || "diff";
        await spawn(argv.command, [file, temp], {stdio: "inherit"});
    },
    async unknown(arg, args){
        log(chalk`Unknown action {red ${arg}} try '{white rally help preset}'`);
    },
}

let rulesub = {
    async before(args){
        this.env = args.env;
        if(!this.env) throw new AbortError("No env supplied");
    },
    async $list(args){
        log("Loading...");
        let rules = await Rule.getAll(this.env);
        if(configObject.rawOutput) return rules;

        log(chalk`{yellow ${rules.length}} rules on {green ${this.env}}.`);
        rules.arr.sort((a, b) => {
            return Number(a.data.attributes.updatedAt) - Number(b.data.attributes.updatedAt)
        });
        for(let rule of rules) log(rule.chalkPrint());
    },
    async $create(args){
        let preset = await configHelpers.selectPreset();
        let passNext = await configHelpers.selectRule("'On Exit OK'");
        let errorNext = await configHelpers.selectRule("'On Exit Error'");
        let name = await configHelpers.askInput("Rule Name", "What is the rule name?");
        name = name.replace("@", preset.name);
        let desc = await configHelpers.askInput("Description", "Enter a description.");

        let dynamicNexts = [];
        let next;
        while(next = await configHelpers.selectRule("dynamic next")){
            let name = await configHelpers.askInput("Key", "Key name for dynamic next");
            dynamicNexts.push({
                meta: {
                    transition: name,
                },
                type: "workflowRules",
                name: next.name,
            });
        }

        let rule = new Rule({subProject: configObject.project});
        rule.name = name;
        rule.description = desc;
        rule.relationships.preset = {data: {name: preset.name, type: "presets"}}
        if(errorNext) rule.relationships.errorNext = {data: {name: errorNext.name, type: "workflowRules"}}
        if(passNext) rule.relationships.passNext = {data: {name: passNext.name, type: "workflowRules"}}
        if(dynamicNexts[0]){
            rule.relationships.dynamicNexts = {
                data: dynamicNexts
            };
        }

        rule.saveB()
    },
    async unknown(arg, args){
        log(chalk`Unknown action {red ${arg}} try '{white rally help rule}'`);
    },
}

let jupytersub = {
    async before(args){
        this.input = args._.shift() || "main.ipynb";
        this.output = args._.shift() || "main.py";
    },
    async $build(args){
        let cmd = `jupyter nbconvert --to python ${this.input} --TagRemovePreprocessor.remove_cell_tags={\"remove_cell\"} --output ${this.output} --TemplateExporter.exclude_markdown=True --TemplateExporter.exclude_input_prompt=True --TemplateExporter.exclude_output_prompt=True`.split(" ");
        log(chalk`Compiling GCR file {green ${this.input}} into {green ${this.output}} using jupyter...`);

        try{
            let {timestr} = await spawn(cmd[0], cmd.slice(1));
            log(chalk`Complete in ~{green.bold ${timestr}}.`);
        }catch(e){
            if(e.code !== "ENOENT") throw e;
            log(chalk`Cannot run the build command. Make sure that you have jupyter notebook installed.\n{green pip install jupyter}`);
            return;
        }
    },
}

async function categorizeString(str, defaultSubproject=undefined){
    str = str.trim();
    if(str.startsWith('"')){
        str = str.slice(1, -1);
    }
    let match
    if(match = /^(\w)-(\w{1,10})-(\d{1,10}):/.exec(str)){
        if(match[1] === "P"){
            let ret = await Preset.getById(match[2], match[3]);
            //TODO modify for subproject a bit
            return ret;
        }else if(match[1] === "R"){
            return await Rule.getById(match[2], match[3]);
        }else{
            return null;
        }
    }else if(match = /^([\w \/\\\-_]*)[\/\\]?silo\-(\w+)[\/\\]/.exec(str)){
        try{
            switch(match[2]){
                case "presets": return new Preset({path: str, subProject: match[1]});
                case "rules": return new Rule({path: str, subProject: match[1]});
                case "metadata": return await Preset.fromMetadata(str, match[1]);
            }
        }catch(e){
            log(e);
        }
    }else{
        return null;
    }
}

let tagsub = {
    async before(args){
        this.env = args.env;
        if(!this.env) throw new AbortError("No env supplied");
    },
    async $list(args){
        log("Loading...");
        let tags = await Tag.getAll(this.env);
        if(configObject.rawOutput) return tags;

        log(chalk`{yellow ${tags.length}} tags on {green ${this.env}}.`);
        tags.arr.sort((a, b) => {
            return Number(a.data.attributes.updatedAt) - Number(b.data.attributes.updatedAt)
        });
        for(let tag of tags) log(tag.chalkPrint());
    },
    async $create(args){
        return Tag.create(this.env, "testTag");
    }
};

let supplysub = {
    async before(args){
        this.env = args.env;
        if(!this.env) throw new AbortError("No env supplied");
        this.files = await getFilesFromArgs(args);
    },

    //Calculate a supply chain based on a starting rule at the top of the stack
    async $calc(args){
        let name = args._.shift();
        let stopName = args._.shift();
        if(!name){
            throw new AbortError("No starting rule or @ supplied");
        }

        if(name === "@"){
            log(chalk`Silo clone started`);
            this.chain = new SupplyChain();
            this.chain.remote = args.env;
        }else{
            let rules = await Rule.getAll(this.env);
            let stop, start;
            start = rules.findByNameContains(name);
            if(stopName) stop = rules.findByNameContains(stopName);

            if(!start){
                throw new AbortError(chalk`No starting rule found by name {blue ${name}}`);
            }
            log(chalk`Analzying supply chain: ${start.chalkPrint(false)} - ${stop ? stop.chalkPrint(false) : "(open)"}`);
            this.chain = new SupplyChain(start, stop);
        }

        await this.chain.calculate();
        return await this.postAction(args);
    },
    async postAction(args){
        //Now that we ahve a supply chain object, do something with it
        if(args["to"]){
            this.chain.log();
            if(this.chain.presets.arr[0]){
                await this.chain.downloadPresetCode(this.chain.presets);
                log("Done");
            }

            if(Array.isArray(args["to"])){
                for(let to of args["to"]){
                    await this.chain.syncTo(to);
                }
            }else{
                await this.chain.syncTo(args["to"]);
            }
        }else if(args["diff"]){
            //Very basic diff
            let env = args["diff"];
            await Promise.all(this.chain.presets.arr.map(obj => obj.downloadCode()));
            await Promise.all(this.chain.presets.arr.map(obj => obj.resolve()));

            let otherPresets = await Promise.all(this.chain.presets.arr.map(obj => Preset.getByName(env, obj.name)));
            otherPresets = new Collection(otherPresets.filter(x => x));
            await Promise.all(otherPresets.arr.map(obj => obj.downloadCode()));
            await Promise.all(otherPresets.arr.map(obj => obj.resolve()));

            const printPresets = (preset, otherPreset) => {
                log(preset.chalkPrint(true));
                if(otherPreset.name){
                    log(otherPreset.chalkPrint(true));
                }else{
                    log(chalk`{red (None)}`);
                }
            }

            for(let preset of this.chain.presets){
                let otherPreset = otherPresets.arr.find(x => x.name === preset.name) || {};

                if(preset.code === otherPreset.code){
                    if(!args["ignore-same"]){
                        printPresets(preset, otherPreset);
                        log("Code Same");
                    }
                }else{
                    printPresets(preset, otherPreset);
                    if(args["ignore-same"]){
                        log("-------");
                    }else{
                        log("Code Different");
                    }
                }
            }

        }else{
            return await this.chain.log();
        }

    },
    async $make(args){
        let set = new Set();
        let hints = args.hint ? (Array.isArray(args.hint) ? args.hint : [args.hint]) : []
        //TODO modify for better hinting, and add this elsewhere
        for(let hint of hints){
            if(hint === "presets-uat"){
                log("got hint");
                await Preset.getAll("UAT");
            }
        }

        for(let file of this.files){
            set.add(await categorizeString(file));
        }
        let files = [...set];
        files = files.filter(f => f && !f.missing);
        this.chain = new SupplyChain();

        this.chain.rules = new Collection(files.filter(f => f instanceof Rule));
        this.chain.presets = new Collection(files.filter(f => f instanceof Preset));
        this.chain.notifications = new Collection([]);

        return await this.postAction(args);
    },
    async unknown(arg, args){
        log(chalk`Unknown action {red ${arg}} try '{white rally help supply}'`);
    },
}

function subCommand(object){
    object = {
        before(){}, after(){}, unknown(){},
        ...object
    };
    return async function(args){
        //Grab the next arg on the stack, find a function tied to it, and run
        let arg = args._.shift();
        let key = "$" + arg;
        let ret;
        if(object[key]){
            await object.before(args);
            ret = await object[key](args);
            await object.after(args);
        }else{
            if(arg === undefined) arg = "(None)";
            object.unknown(arg, args);
        }
        return ret;
    }
}

let cli = {
    @helpText(`Display the help menu`)
    @usage(`rally help [subhelp]`)
    @param("subhelp", "The name of the command to see help for")
    async help(args){
        let arg = args._.shift();
        if(arg){
            let help = helpEntries[arg];
            if(!help){
                log(chalk`No help found for '{red ${arg}}'`);
            }else{
                log(printHelp(helpEntries[arg]));
            }
        }else{
            for(let helpArg in helpEntries){
                log(printHelp(helpEntries[helpArg], true));
            }
        }
    },

    @helpText("Rally tools jupyter interface. Requires jupyter to be installed.")
    @usage("rally jupyter build [in] [out]")
    @param("in/out", "input and output file for jupyter. By default main.ipyrb and main.py")
    async jupyter(args){
        return subCommand(jupytersub)(args);
    },

    //@helpText(`Print input args, for debugging`)
    async printArgs(args){
        log(args);
    },

    @helpText(`Preset related actions`)
    @usage(`rally preset [action] --env <enviornment> --file [file1] --file [file2] ...`)
    @param("action", "The action to perform. Can be upload, diff, list")
    @arg("-e", "--env", "The enviornment you wish to perform the action on")
    @arg("-f", "--file", "A file to act on")
    @arg("~", "--command", "If the action is diff, this is the command to run instead of diff")
    async preset(args){
        return subCommand(presetsub)(args);
    },

    @helpText(`Rule related actions`)
    @usage(`rally rule [action] --env [enviornment]`)
    @param("action", "The action to perform. Only list is supported right now")
    @arg("-e", "--env", "The enviornment you wish to perform the action on")
    async rule(args){
        return subCommand(rulesub)(args);
    },

    @helpText(`supply chain related actions`)
    @usage(`rally supply [action] [identifier] --env [enviornment]`)
    @param("action", "The action to perform. Can be calc.")
    @param("identifier", "If the action is calc, then this identifier should be the first rule in the chain.")
    @arg("-e", "--env", "The enviornment you wish to perform the action on")
    async supply(args){
        return subCommand(supplysub)(args);
    },

    @helpText(`tags stuff`)
    @usage(`rally tags [action]`)
    @param("action", "The action to perform. Can be list or create.")
    @arg("-e", "--env", "The enviornment you wish to perform the action on")
    async tag(args){
        return subCommand(tagsub)(args);
    },

    @helpText(`print out some trace info`)
    @usage(`rally trace -e [env] [jobid]`)
    @param("jobid", "a job id like b86d7d90-f0a5-4622-8754-486ca8e9ecbd")
    @arg("-e", "--env", "The enviornment you wish to perform the action on")
    async trace(args){
        let jobId = args._.shift();
        if(!jobId) throw new AbortError("No job id");
        if(!args.env) throw new AbortError("no env");

        let traceInfo = await parseTrace(args.env, jobId);

        for(let line of traceInfo){
            if(typeof(line) == "string"){
                log(chalk.red(line));
            }else{
                printOutLine(line);
            }
        }

        return true;
    },

    @helpText(`List all available providers, or find one by name/id`)
    @usage(`rally providers [identifier] --env [env] --raw`)
    @param("identifier", "Either the name or id of the provider")
    @arg("-e", "--env", "The enviornment you wish to perform the action on")
    @arg("~", "--raw", "Raw output of command. If [identifier] is given, then print editorConfig too")
    async providers(args){
        let env = args.env;
        if(!env) return errorLog("No env supplied.");
        let ident = args._.shift();

        let providers = await Provider.getAll(env);

        if(ident){
            let pro = providers.arr.find(x => x.id == ident || x.name.includes(ident));
            if(!pro){
                log(chalk`Couldn't find provider by {green ${ident}}`);
            }else{
                log(pro.chalkPrint(false));
                let econfig = await pro.getEditorConfig();
                if(args.raw){
                    return pro;
                }else{
                    if(econfig.helpText.length > 100){
                        econfig.helpText = "<too long to display>";
                    }
                    if(econfig.completions.length > 5){
                        econfig.completions = "<too long to display>";
                    }
                    log(econfig);
                }
            }
        }else{
            if(args.raw) return providers;
            for(let pro of providers) log(pro.chalkPrint());
        }
    },

    @helpText(`Change config for rally tools`)
    @usage("rally config [key] --set [value] --raw")
    @param("key", chalk`Key you want to edit. For example, {green chalk} or {green api.DEV}`)
    @arg("~", "--set", "If this value is given, no interactive prompt will launch and the config option will change.")
    @arg("~", "--raw", "Raw output of json config")
    async config(args){
        let prop = args._.shift();
        let propArray = prop && prop.split(".");

        //if(!await configHelpers.askQuestion(`Would you like to create a new config file in ${configFile}`)) return;
        let newConfigObject;

        if(!prop){
            if(configObject.rawOutput) return configObject;
            log("Creating new config");
            newConfigObject = {
                ...configObject,
            };
            for(let helperName in configHelpers){
                if(helperName.startsWith("$")){
                    newConfigObject = {
                        ...newConfigObject,
                        ...(await configHelpers[helperName](false))
                    }
                }
            }
        }else{
            log(chalk`Editing option {green ${prop}}`);
            if(args.set){
                newConfigObject = {
                    ...configObject,
                    [prop]: args.set,
                };
            }else{
                let ident = "$" + propArray[0];

                if(configHelpers[ident]){
                    newConfigObject = {
                        ...configObject,
                        ...(await configHelpers[ident](propArray))
                    };
                }else{
                    log(chalk`No helper for {red ${ident}}`);
                    return;
                }
            }
        }

        newConfigObject.hasConfig = true;

        //Create readable json and make sure the user is ok with it
        let newConfig = JSON.stringify(newConfigObject, null, 4);
        log(newConfig);

        //-y or --set will make this not prompt
        if(!args.y && !args.set && !await configHelpers.askQuestion("Write this config to disk?")) return;
        writeFileSync(configFile, newConfig, {mode: 0o600});
        log(chalk`Created file {green ${configFile}}.`);
    },

    @helpText(`create/modify asset`)
    @usage("rally asset [action] [action...]")
    @param("action", chalk`Options are create, delete, launch, addfile. You can supply multiple actions to chain them`)
    @arg(`-i`, `--id`,         chalk`MOVIE_ID of asset to select`)
    @arg(`-n`, `--name`,       chalk`MOVIE_NAME of asset. with {white create}, '{white #}' will be replaced with a uuid. Default is '{white TEST_#}'`)
    @arg(`-j`, `--job-name`,   chalk`Job name to start (used with launch)`)
    @arg(`~`,  `--init-data`,  chalk`Init data to use when launching job. can be string, or {white @path/to/file} for a file`)
    @arg(`~`,  `--file-label`, chalk`File label (used with addfile)`)
    @arg(`~`,  `--file-uri`,   chalk`File s3 uri. Can use multiple uri's for the same label (used with addfile)`)
    async asset(args){
        function uuid(args){
            const digits = 16;
            return String(Math.floor(Math.random() * Math.pow(10, digits))).padStart(digits, "0");
        }

        let name = args.name || `TEST_#`;
        let env = args.env;

        let asset;
        let arg = args._.shift()
        if(!arg){
            throw new AbortError(chalk`Missing arguments: see {white 'rally help asset'}`);
        }

        if(args.anon){
            args._.unshift(arg);
        }else if(arg == "create"){
            name = name.replace("#", uuid());
            asset = await Asset.createNew(name, env);
        }else{
            args._.unshift(arg);
            if(args.id){
                asset = Asset.lite(args.id, env);
            }else{
                asset = await Asset.getByName(env, args.name);
            }
        }

        if(!asset && !args.anon){
            throw new AbortError("No asset found/created");
        }
        let launchArg = 0;
        let fileArg = 0;

        let arrayify = (obj, i) => Array.isArray(obj) ? obj[i] : (i == 0 ? obj : undefined);

        while(arg = args._.shift()){
            if(arg === "launch"){
                let initData = arrayify(args["init-data"], launchArg);
                if(initData && initData.startsWith("@")){
                    log(chalk`Reading init data from {white ${initData.slice(1)}}`);
                    initData = readFileSync(initData.slice(1), "utf-8");
                }

                let jobName = arrayify(args["job-name"], launchArg);
                let p = await Rule.getByName(env, jobName);
                if(!p){
                    throw new AbortError(`Cannot launch job ${jobName}, does not exist (?)`);
                }else{
                    log(chalk`Launching ${p.chalkPrint(false)} on ${asset ? asset.chalkPrint(false) : "(None)"}`);
                }

                if(asset){
                    await asset.startWorkflow(jobName, initData)
                }else{
                    await Asset.startAnonWorkflow(env, jobName, initData)
                }
                launchArg++;
            }else if(arg === "addfile"){
                let label = arrayify(args["file-label"], fileArg)
                let uri   = arrayify(args["file-uri"], fileArg)
                if(label === undefined || !uri){
                    throw new AbortError("Number of file-label and file-uri does not match");
                }
                await asset.addFile(label, uri);
                log(chalk`Added file ${label}`);
                fileArg++;
            }else if(arg === "delete"){
                await asset.delete();
            }else if(arg === "create"){
                throw new AbortError(`Cannot have more than 1 create/get per asset call`);
            }else if(arg === "show"){
                log(asset);
            }
        }
        if(configObject.rawOutput) return asset;
    },

    async checkSegments(args){
        let asset = args._.shift()
        let res = await allIndexBundle.lib.makeAPIRequest({
            env: args.env, path: `/movies/${asset}/metadata/Metadata`,
        });
        let segments = res.data.attributes.metadata.userMetaData.segments.segments;

        let r = segments.reduce((lastSegment, val, ind) => {
            let curSegment = val.startTime;
            if(curSegment < lastSegment){
                log("bad segment " + (ind + 1))
            }
            return val.endTime
         }, "00:00:00:00");
    },

    async listAssets(args, tag){
        let req = await allIndexBundle.lib.indexPathFast({
            env: args.env, path: "/assets",
            qs: {
                noRelationships: true,
                sort: "id",
            },
            chunksize: 30,
        });
        for(let asset of req){
            log(asset.id);
        }

        return req;
    },

    async listSegments(args){
        let f = JSON.parse(readFileSync(args.file, "utf-8"));

        for(let asset of f){
            let r = await allIndexBundle.lib.makeAPIRequest({
                env: args.env, path: `/movies/${asset.id}/metadata/Metadata`,
            });

            let segs = r.data.attributes.metadata.userMetaData?.segments?.segments;
            if(segs && segs.length > 1){
                log(asset.id);
                log(asset.name);
            }
        }
    },
    async test2(args){
        let wfr = await allIndexBundle.lib.indexPath({
            env: args.env, path: "/workflowRuleMetadata",
        });
        log(wfr);

        for(let wfrm of wfr){
            try{
                wfrm.id = undefined;
                wfrm.links = undefined;
                log(wfrm);
                let req = await allIndexBundle.lib.makeAPIRequest({
                    env: "DEV", path: "/workflowRuleMetadata",
                    method: "POST",
                    payload: {data: wfrm},
                })
            }catch(e){
                log("caught");
            }
            //break;
        }
    },

    async test3(args){
        let wfr = await allIndexBundle.lib.indexPath({
            env: args.env, path: "/workflowRuleMetadata",
        });
        log(wfr);

        for(let wfrm of wfr){
            try{
                wfrm.id = undefined;
                wfrm.links = undefined;
                log(wfrm);
                let req = await allIndexBundle.lib.makeAPIRequest({
                    env: "DEV", path: "/workflowRuleMetadata",
                    method: "POST",
                    payload: {data: wfrm},
                })
            }catch(e){
                log("caught");
            }
            //break;
        }
    },

    sleep(time = 1000){
        return new Promise(resolve => setTimeout(resolve, time));
    },

    async audit(args){
        let supportedAudits = ["presets", "rule", "other"];
        await configHelpers.addAutoCompletePrompt();
        let q = await configHelpers.inquirer.prompt([{
            type: "autocomplete", name: "obj",
            message: `What audit do you want?`,
            source: async (sofar, input) => {
                return supportedAudits.filter(x => input ? x.includes(input.toLowerCase()) : true);
            },
        }]);
        let choice = q.obj;
        let resourceId = undefined
        let filterFunc = _=>_;
        if(choice === "presets"){
            let preset = await configHelpers.selectPreset();
            let remote = await Preset.getByName(args.env, preset.name);
            if(!remote) throw new AbortError("Could not find this item on remote env");
            filterFunc = ev => ev.resource == "Preset";
            resourceId = remote.id;
        }else if(choice === "rule"){
            let preset = await configHelpers.selectRule();
            let remote = await Rule.getByName(args.env, preset.name);
            if(!remote) throw new AbortError("Could not find this item on remote env");
            filterFunc = ev => ev.resource == "Rule";
            resourceId = remote.id;
        }else{
            resourceId = await configHelpers.askInput(null, "What resourceID?");
        }

        log(chalk`Resource ID on {blue ${args.env}} is {yellow ${resourceId}}`);
        log(`Loading audits (this might take a while)`);
        const numRows = 100;
        let r = await allIndexBundle.lib.makeAPIRequest({
            env: args.env,
            path: `/v1.0/audit?perPage=${numRows}&count=${numRows}&filter=%7B%22resourceId%22%3A%22${resourceId}%22%7D&autoload=false&pageNum=1&include=`,
            timeout: 180000,
        });
        r.data = r.data.filter(filterFunc);

        log("Data recieved, parsing users");

        for(let event of r.data){
            let uid = event?.correlation?.userId;
            if(!uid) continue;
            try{
                event.user = await User.getById(args.env, uid);
            }catch(e){
                event.user = {name: "????"};
            }
        }

        if(args.raw) return r.data;
        let evCounter = 0;
        for(let event of r.data){
            let evtime = moment(event.createdAt);
            let date = evtime.format("ddd YYYY/MM/DD hh:mm:ssa");
            let timedist = evtime.fromNow();
            log(chalk`${date} {yellow ${timedist}} {green ${event.user?.name}} ${event.event}`);

            if(++evCounter >= 30) break;
        }
    },

    async audit2(args){
        const numRows = 1000
        let r = await allIndexBundle.lib.makeAPIRequest({
            env: args.env,
            //path: `/v1.0/audit?perPage=${numRows}&count=${numRows}&autoload=false&pageNum=1&include=`,
            path: `/v1.0/audit?perPage=${numRows}&count=${numRows}&filter=%7B%22correlation.userId%22%3A%5B%22164%22%5D%7D&autoload=false&pageNum=1&include=`,
            timeout: 60000,
        });
        for(let event of r.data){
            log(event.event);
        }
    },

    async findIDs(args){
        let files = await getFilesFromArgs(args);
        for(let file of files){
            let preset = await Preset.getByName(args.env, file);
            await preset.resolve();
            log(`silo-presets/${file}.${preset.ext}`);
        }
    },

    async getAssets(env, name){
        if(!this.callid) this.callid = 0;
        this.callid++;
        let callid = this.callid;

        await this.sleep(500);

        if(callid != this.callid) return this.lastResult || [];

        let req = await allIndexBundle.lib.makeAPIRequest({
            env, path: `/assets`,
            qs: name ? {filter: `nameContains=${name}`} : undefined,
        })
        this.lastCall = Date.now();

        return this.lastResult = req.data;
    },

    async content(args){
        configHelpers.addAutoCompletePrompt();
        let q = await configHelpers.inquirer.prompt([{
            type: "autocomplete",
            name: "what",
            message: `What asset do you want?`,
            source: async (sofar, input) => {
                let assets = await this.getAssets(args.env, input);
                assets = assets.map(x => new Asset({data: x, remote: args.env}));
                return assets.map(x => ({
                    name: x.chalkPrint(true) + ": " + x.data.links.self.replace("/api/v2/assets/", "/content/"),
                    value: x,
                }));
            },
        }]);
    },

    async ["@"](args){
        args._.unshift("-");
        args._.unshift("make");
        return this.supply(args);
    },

    async test(args){
        let asset = await Asset.getByName("UAT", args.name);
        log(asset);
    },

    //Used to test startup and teardown speed.
    noop(){
        return true;
    },
};
async function unknownCommand(cmd){
    log(chalk`Unknown command {red ${cmd}}.`);
}

async function noCommand(){
    write(chalk`
Rally Tools {yellow v${packageVersion} (alpha)} CLI
by John Schmidt <John_Schmidt@discovery.com>
`);

    //Prompt users to setup one time config.
    if(!configObject.hasConfig){
        write(chalk`
It looks like you haven't setup the config yet. Please run '{green rally config}'.
`);
        return;
    }

    //API Access tests
    for(let env of ["LOCAL", "DEV", "UAT", "QA", "PROD"]){
        //Test access. Returns HTTP response code
        let resultStr;
        try{
            let result = await funcs.testAccess(env);

            //Create a colored display and response
            resultStr = chalk`{yellow ${result} <unknown>}`;
            if(result === 200) resultStr = chalk`{green 200 OK}`;
            else if(result === 401) resultStr = chalk`{red 401 No Access}`;
            else if(result >= 500)  resultStr = chalk`{yellow ${result} API Down?}`;
            else if(result === true) resultStr = chalk`{green OK}`;
            else if(result === false) resultStr = chalk`{red BAD}`;
        }catch(e){
            if(e instanceof UnconfiguredEnvError){
                resultStr = chalk`{yellow Unconfigured}`;
            }else if(e instanceof APIError){
                if(!e.response.body){
                    resultStr = chalk`{red Timeout (?)}`;
                }
            }else if(e.name == "RequestError"){
                resultStr = chalk`{red Low level error (check internet): ${e.error.errno}}`;
            }else{
                throw e;
            }
        }

        log(chalk`   ${env}: ${resultStr}`);
    }
}

async function $main(){
    //Supply --config to load a different config file
    if(argv.config) loadConfig(argv.config);

    // First we need to decide if the user wants color or not. If they do want
    // color, we need to make sure we use the right mode
    chalk.enabled = configObject.hasConfig ? configObject.chalk : true;
    if(chalk.level === 0 || !chalk.enabled){
        let force = argv["force-color"];
        if(force){
            chalk.enabled = true;
            if(force === true && chalk.level === 0){
                chalk.level = 1;
            }else if(Number(force)){
                chalk.level = Number(force);
            }
        }
    }

    //This flag being true allows you to modify UAT and PROD
    if(!argv["protect"]){
        configObject.dangerModify = true;
    }

    //This enables raw output for some functions
    if(argv["raw"]){
        configObject.rawOutput = true;
        global.log = ()=>{};
        global.errorLog = ()=>{};
        global.write = ()=>{};
    }

    if(argv["ignore-missing"]){
        configObject.ignoreMissing = true;
    }

    //Default enviornment should normally be from config, but it can be
    //overridden by the -e/--env flag
    if(configObject.defaultEnv){
        argv.env = argv.env || configObject.defaultEnv;
    }

    //Enable verbose logging in some places.
    if(argv["vverbose"]){
        configObject.verbose = argv["vverbose"];
        configObject.vverbose = true;
    }else if(argv["verbose"]){
        configObject.verbose = argv["verbose"]
    }else if(argv["vvverbose"]){
        configObject.verbose = true;
        configObject.vverbose = true;
        configObject.vvverbose = true;
    }

    //copy argument array to new object to allow modification
    argv._old = argv._.slice();

    //Take first argument after `node bundle.js`
    //If there is no argument, display the default version info and API access.
    let func = argv._.shift();
    if(func){
        if(!cli[func]) return await unknownCommand(func);
        try{
            //Call the cli function
            let ret = await cli[func](argv);
            if(ret){
                write(chalk.white("CLI returned: "));
                if(ret instanceof Collection) ret = ret.arr;

                //Directly use console.log so that --raw works as intended.
                if(typeof ret === "object"){
                    console.log(JSON.stringify(ret, null, 4));
                }else{
                    console.log(ret);
                }
            }
        }catch(e){
            if(e instanceof AbortError){
                log(chalk`{red CLI Aborted}: ${e.message}`);
            }else{
                throw e;
            }
        }
    }else{
        await noCommand();
    }
}

async function main(...args){
    //Catch all for errors to avoid ugly default node promise catcher
    try{
        await $main(...args);
    }catch(e){
        errorLog(e.stack);
    }
}

// If this is an imported module, then we should exec the cli interface.
// Oterwise just export everything.
if(require.main === module){
    main();
}else{
    module.exports = allIndexBundle;
}

import {cached, defineAssoc} from "./decorators.js";
import {lib, Collection, RallyBase} from "./rally-tools.js";
import File from "./file.js";

class Asset extends RallyBase{
    constructor({data, remote, included}){
        super();
        this.data = data;
        this.meta = {};
        this.remote = remote;
        if(included){
            this.meta.metadata = Asset.normalizeMetadata(included);
        }
    }
    static normalizeMetadata(payload){
        let newMetadata = {}
        for(let md of payload){
            if(md.type !== "metadata") continue;
            newMetadata[md.attributes.usage] = md.attributes.metadata;
        }
        return newMetadata;
    }

    static lite(id, remote){
        return new this({data: {id}, remote})
    }

    chalkPrint(pad=false){
        let id = String("A-" + (this.remote && this.remote + "-" + this.id || "LOCAL"))
        if(pad) id = id.padStart(15);
        return chalk`{green ${id}}: {blue ${this.data.attributes ? this.name : "(lite asset)"}}`;
    }

    static async createNew(name, env){
        let req = await lib.makeAPIRequest({
            env, path: "/assets",
            method: "POST",
            payload: {
                data: {
                    attributes: {name},
                    type: "assets"
                }
            }
        });
        return new this({data: req.data, remote: env});
    }

    async delete(){
        let req = await lib.makeAPIRequest({
            env: this.remote, path: "/assets/" + this.id,
            method: "DELETE",
        });
    }

    async getFiles(){
        let req = await lib.indexPathFast({
            env: this.remote, path: `/assets/${this.id}/files`,
            method: "GET",
        });

        //return req;
        return new Collection(req.map(x => new File({data: x, remote: this.remote, parent: this})));
    }

    async addFile(label, fileuris){
        if(!Array.isArray(fileuris)) fileuris = [fileuris];

        let instances = {}
        for(let i = 0; i < fileuris.length; i++){
            instances[String(i + 1)] = {uri: fileuris[i]};
        }

        let req = await lib.makeAPIRequest({
            env: this.remote, path: "/files",
            method: "POST",
            payload: {
                "data": {
                    "attributes": {
                        label, instances,
                    },
                    "relationships": {
                        "asset": {
                            "data": {
                                id: this.id,
                                "type": "assets"
                            }
                        }
                    },
                    "type": "files"
                }

            }
        });
        return req;
    }
    async startWorkflow(jobName, initData){
        let attributes;
        if(initData){
            //Convert init data to string
            initData = typeof initData === "string" ? initData : JSON.stringify(initData);
            attributes = {initData};
        }

        let req = await lib.makeAPIRequest({
            env: this.remote, path: "/workflows",
            method: "POST",
            payload: {
                "data": {
                    "type": "workflows",
                    attributes,
                    "relationships": {
                        "movie": {
                            "data": {
                                id: this.id,
                                "type": "movies"
                            }
                        }, "rule": {
                            "data": {
                                "attributes": {
                                    "name": jobName,
                                },
                                "type": "rules"
                            }
                        }
                    }
                }
            }
        });
        return req;
    }
    static async startAnonWorkflow(env, jobName, initData){
        let attributes;
        if(initData){
            //Convert init data to string
            initData = typeof initData === "string" ? initData : JSON.stringify(initData);
            attributes = {initData};
        }

        let req = await lib.makeAPIRequest({
            env, path: "/workflows",
            method: "POST",
            payload: {
                "data": {
                    "type": "workflows",
                    attributes,
                    "relationships": {
                        "rule": {
                            "data": {
                                "attributes": {
                                    "name": jobName,
                                },
                                "type": "rules"
                            }
                        }
                    }
                }
            }
        });
        return req;

    }
    async startEvaluate(presetid){
        // Fire and forget.
        let data = await lib.makeAPIRequest({
            env: this.remote, path: "/jobs", method: "POST",
            payload: {
                data: {
                    type: "jobs",
                    relationships: {
                        movie: {
                            data: {
                                id: this.id,
                                type: "movies",
                            }
                        }, preset: {
                            data: {
                                id: presetid,
                                type: "presets",
                            }
                        }
                    }
                }
            }
        });
        return data;
    }
}

defineAssoc(Asset, "id", "data.id");
defineAssoc(Asset, "name", "data.attributes.name");
defineAssoc(Asset, "remote", "meta.remote");
defineAssoc(Asset, "md", "meta.metadata");
Asset.endpoint = "movies"

export default Asset;

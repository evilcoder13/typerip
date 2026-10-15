import axios from 'axios';
import saveAs from 'file-saver';
import JSZip from 'jszip';
import 'https://unpkg.com/wawoff2@2.0.1/build/decompress_binding.js';

export default class TypeRip {
    static CORSProxies = [
        "https://typerip-cors-proxy.damneddevil.workers.dev/?url=",
        "https://api.allorigins.win/raw?url=",
        "https://api.codetabs.com/v1/proxy/?quest=",
        "https://corsproxy.io/?url=",
    ];

    static Messages = Object.freeze({
        RequestFailed: "Check that the Adobe Fonts URL is correct, then check your internet connection, and then try again.",
        MalformedFontResponse: "Unexpected Adobe Fonts page structure. Please check your URL and try again, otherwise open an issue on GitHub.",
        AllProxiesFailed: "All CORS proxies failed. Please check your internet connection, otherwise open an issue on GitHub."
    })

    static URLTypes = Object.freeze({
        Invalid: 0,
        FontFamily: 1,
        FontCollection: 2
    });

    static ResponseTypes = Object.freeze({
        Success: 0,
        Error: 1
    });

    static prependHttpsToURL(url) {
        if (!url.toLowerCase().startsWith("http://") && !url.toLowerCase().startsWith("https://")) {
            url = "https://" + url;
        }
        return url
    }

    static getURLType(url){
        if(url.indexOf("fonts.adobe.com/collections") != -1){
            return this.URLTypes.FontCollection;
        }else if(url.indexOf("fonts.adobe.com/fonts") != -1){
            return this.URLTypes.FontFamily;
        }else{
            return this.URLTypes.Invalid;
        }
    }

    static getNetworkResource(url_) {
        let storedIndex = parseInt(localStorage.getItem("cors_proxy_index"), 10);
        let last_working_cors_proxy_index = (Number.isInteger(storedIndex) && storedIndex >= 0 && storedIndex < this.CORSProxies.length)
            ? storedIndex
            : 0;

        let re_ordered_cors_proxies = [...this.CORSProxies];
        if (last_working_cors_proxy_index > 0) {
            let primary = re_ordered_cors_proxies.splice(last_working_cors_proxy_index, 1)[0];
            re_ordered_cors_proxies.unshift(primary);
        }

        function try_all_proxies_until_success(proxy_index, proxy_list) {
            let proxy = proxy_list[proxy_index];
            let proxyUrl = proxy.includes('?') ? proxy + encodeURIComponent(url_) : proxy + url_;

            return new Promise(function(resolve, reject) {
                console.log(`[TypeRip] Trying proxy [${proxy_index + 1}/${proxy_list.length}]: ${proxy}`);

                axios.get(proxyUrl, {
                    timeout: 10000,
                    responseType: 'text'
                })
                .then((response) => {
                    if (!response || !response.data || typeof response.data !== 'string' || response.data.trim().length === 0) {
                        throw new Error(`Empty or invalid response from proxy: ${proxy}`);
                    }

                    // Save the successfully working index in original CORSProxies list
                    let originalIndex = TypeRip.CORSProxies.indexOf(proxy);
                    if (originalIndex !== -1) {
                        localStorage.setItem("cors_proxy_index", originalIndex.toString());
                    }
                    console.log(`[TypeRip] Successful proxy: ${proxy} (HTTP ${response.status})`);
                    resolve(response);
                })
                .catch((error) => {
                    let status = error.response ? error.response.status : 'No response';
                    let code = error.code || 'N/A';
                    console.warn(`[TypeRip] Proxy failed: ${proxy} | Status: ${status} | Code: ${code} | Message: ${error.message}`);

                    if (proxy_index + 1 >= proxy_list.length) {
                        reject({ message: TypeRip.Messages.AllProxiesFailed + " (#007)" });
                    } else {
                        try_all_proxies_until_success(proxy_index + 1, proxy_list)
                            .then(resolve)
                            .catch(reject);
                    }
                });
            });
        }

        return try_all_proxies_until_success(0, re_ordered_cors_proxies);
    }

    //TODO: refactor this so that it returns a Promise instead of manually specifying a 'callback_' method.
    // then we can have our promise provide a "resolve" and "reject" interface instead of using this stupid `ResponseTypes` enum system
    static getFontCollection(url_, callback_){
        this.getNetworkResource(url_)
        .then((response) => {
            let fontCollection = {
                name: "",
                designers: [],
                fonts: []
            }

            //search for the first part of the json
            let json_start = response.data.toString().search('{"fontpack":{"all_valid_slugs":'); 
		    if(json_start == -1) {
                callback_(this.ResponseTypes.Error, TypeRip.Messages.RequestFailed + " (#001)")
                
                // Because (as we've seen with corsproxy.io) it's possible for Adobe to return a 404 page to a proxy 
                //      when given a valid url, we have to consider that cors proxy can be blacklisted.
                // For this reaosn, we want to increment the cors_proxy_index so when the user tries agian, TypeRip will
                //      attempt the network request with a different proxy.
                localStorage.setItem("cors_proxy_index", parseInt(localStorage.getItem("cors_proxy_index")) + 1)
                return
            }

            //cut off everything before this point
            let data = response.data.substring(json_start)

            //find the stuff directly after the json, and use this as the anchor    
            let json_end = data.search('</script>') 
            if(json_end == -1) {
                callback_(this.ResponseTypes.Error, TypeRip.Messages.MalformedFontResponse + " (#002)")
                return
            }

            //parse the json blob
            let json;
            try {
                json = JSON.parse(data.substring(0, json_end)); 
            }catch(e){
                callback_(this.ResponseTypes.Error,  TypeRip.Messages.MalformedFontResponse + " (#003)")
                return
            }

            //find the default language of the first font in this collection.
            fontCollection.defaultLanguage = json.fontpack.font_variations[0].default_language;

            //grab the sample text data for this language
            fontCollection.sampleText = json.textSampleData.textSamples[fontCollection.defaultLanguage]["list"]; 
            
            //Font collection name
            fontCollection.name = json.fontpack.name

            //Find the contributor who curated this collection:
            fontCollection.designers.push({
                "name": json.fontpack.contributor_credit,
                "url": url_
            })
            
            //populate subfonts
            for (let i = 0; i < json.fontpack.font_variations.length; i++) {
                fontCollection.fonts.push({
                    url: "https://use.typekit.net/pf/tk/" + json.fontpack.font_variations[i].opaque_id + "/" + json.fontpack.font_variations[i].fvd + "/l?unicode=AAAAAQAAAAEAAAAB&features=ALL&v=3&ec_token=3bb2a6e53c9684ffdc9a9bf71d5b2a620e68abb153386c46ebe547292f11a96176a59ec4f0c7aacfef2663c08018dc100eedf850c284fb72392ba910777487b32ba21c08cc8c33d00bda49e7e2cc90baff01835518dde43e2e8d5ebf7b76545fc2687ab10bc2b0911a141f3cf7f04f3cac438a135f", 
                    name: json.fontpack.font_variations[i].full_display_name,
                    style: json.fontpack.font_variations[i].variation_name, 
                    familyName: json.fontpack.font_variations[i].family.name,
                    familyUrl: "https://fonts.adobe.com/fonts/" + json.fontpack.font_variations[i].family.slug
                });
            }	

            callback_(this.ResponseTypes.Success, fontCollection)
        })
        .catch( (error) => {
            callback_(this.ResponseTypes.Error, error.message)
        })
    }

    static getFontFamily(url_, callback_) {
        this.getNetworkResource(url_)
        .then((response) => {
            let fontFamily = {
                name: "",
                designers: [],
                fonts: []
            }

            //search for the first part of the json
            let json_start = response.data.toString().search('{"family":{"slug":"'); 
		    if(json_start == -1) {
                callback_(this.ResponseTypes.Error, TypeRip.Messages.RequestFailed + " (#004)")
                
                // Because (as we've seen with corsproxy.io) it's possible for Adobe to return a 404 page to a proxy 
                //      when given a valid url, we have to consider that cors proxy can be blacklisted.
                // For this reaosn, we want to increment the cors_proxy_index so when the user tries agian, TypeRip will
                //      attempt the network request with a different proxy.
                localStorage.setItem("cors_proxy_index", parseInt(localStorage.getItem("cors_proxy_index")) + 1)
                return
            }

            //cut off everything before this point
            let data = response.data.substring(json_start)

            //find the stuff directly after the json, and use this as the anchor    
            let json_end = data.search('</script>') 
            if(json_end == -1) {
                callback_(this.ResponseTypes.Error, TypeRip.Messages.MalformedFontResponse + " (#005)")
                return
            }

            //parse the json blob
            let json;
            try {
                json = JSON.parse(data.substring(0, json_end));
            }catch(e){
                callback_(this.ResponseTypes.Error,  TypeRip.Messages.MalformedFontResponse + " (#006)")
                return
            }

            //find the default language of this font
            fontFamily.defaultLanguage = json.family.display_font.default_language;

            //grab the sample text data for this language
            fontFamily.sampleText = json.textSampleData.textSamples[fontFamily.defaultLanguage]["list"]; 
            
            //family/foundry names
            fontFamily.foundryName = json.family.foundry.name;
            fontFamily.name = json.family.name
            fontFamily.slug = json.family.slug

            //designers
            for(let i = 0; i < json.family.designers.length; i++) {
                let designer = {}
                designer["name"] = json.family.designers[i].name

                if(json.designer_info[json.family.designers[i].slug] != null){
                    designer["url"] = "https://fonts.adobe.com" + json.designer_info[json.family.designers[i].slug].url
                }

                fontFamily.designers.push(designer)
            }

            //populate subfonts
            for (let i = 0; i < json.family.fonts.length; i++) {
                fontFamily.fonts.push({
                    url: "https://use.typekit.net/pf/tk/" + json.family.fonts[i].family.web_id + "/" + json.family.fonts[i].font.web.fvd + "/l?unicode=AAAAAQAAAAEAAAAB&features=ALL&v=3&ec_token=3bb2a6e53c9684ffdc9a9bf71d5b2a620e68abb153386c46ebe547292f11a96176a59ec4f0c7aacfef2663c08018dc100eedf850c284fb72392ba910777487b32ba21c08cc8c33d00bda49e7e2cc90baff01835518dde43e2e8d5ebf7b76545fc2687ab10bc2b0911a141f3cf7f04f3cac438a135f", 
                    name: json.family.fonts[i].name,
                    style: json.family.fonts[i].variation_name, 
                    familyName: json.family.fonts[i].preferred_family_name,
                    familyUrl: "https://fonts.adobe.com/fonts/" + json.family.slug
                });
            }	
            callback_(this.ResponseTypes.Success, fontFamily)
        })
        .catch((error) => {
            callback_(this.ResponseTypes.Error, error.message)
        })
    }

    static async downloadFontsAsZip(fonts, zipfile_name){
        if (fonts.length === 1) {
            var file = await this.getFontFile(fonts[0]);
            saveAs(new Blob([file]), fonts[0].name + ".ttf");
            return;
        }

        const zip = new JSZip();
        for(var i = 0; i < fonts.length; i++) {
            var file = await this.getFontFile(fonts[i]);
            zip.file(fonts[i].name + ".ttf", file);
        }
        
        const content = await zip.generateAsync({ type: "blob" });
        saveAs(content, (zipfile_name || "fonts") + ".zip");
    }

    static async convertWoff2ToTTF(woff2Uint8Array) {
        const loadScript = (src) => new Promise((onload) => document.documentElement.append(
            Object.assign(document.createElement('script'), {src, onload})
          ));
        if (!window.Module || typeof window.Module.decompress !== 'function') {
            const path = 'https://unpkg.com/wawoff2@2.0.1/build/decompress_binding.js';
            const init = new Promise((done) => {
                if (window.Module) {
                    window.Module.onRuntimeInitialized = done;
                } else {
                    window.Module = { onRuntimeInitialized: done };
                }
            });
            await loadScript(path);
            if (typeof window.Module.decompress !== 'function') {
                await init;
            }
        }

        const decompressed = window.Module.decompress(woff2Uint8Array);
        if (!decompressed) {
            throw new Error("Failed to decompress WOFF2 font.");
        }

        // Module.decompress returns a Uint8Array view into Emscripten's WASM HEAP.
        // If we don't slice/clone it, subsequent font decompressions or memory shifts
        // will overwrite/corrupt previously decompressed font data in JSZip.
        return new Uint8Array(decompressed);
    }

    static async getFontFile(font) {
        let response = await axios.get(font.url, {responseType: 'arraybuffer'})
        return this.convertWoff2ToTTF(new Uint8Array(response.data));
    }
}

Hooks.once('socketlib.ready', () =>{
    let socket;

    socket = socketlib.registerModule("pf2e-automated-auras");

    console.log("PF2E Automated Auras | Ready");

    Hooks.on('createItem', async (document, updateData) => {await handleItemCreate(document, updateData, socket)});
    Hooks.on('updateToken', async (document, updateData) => {await handleTokenUpdate(document, updateData, socket)})
    Hooks.on('deleteItem', async (document, updateData) => {await handleItemDelete(document, updateData, socket)})
    Hooks.on('canvasReady', async (document, updateData) => {await handleSceneLoad(document, updateData, socket)})
})

function handleItemCreate(document, updateData, socket){
    console.log("Automated auras | Handling Item Create")
    if(document.type != "effect") return;
    console.log("Automated auras | Item is Effect")
    if(document.data.data.rules[0] == null) return;
    console.log("Automated auras | Effect has rule")
    if(document.data.data.rules[0].key ?? "no" !== "aura") return;
    console.log("Automated auras | effect is aura")

    let sourceID = document.id;
    let effectID = document.data.data.rules[0].effect;
    let token = findTokenFromActor(document.parent)

    let hookIds = []

    hookIds.push(Hooks.on('updateAura', async () => {await onAuraUpdate(sourceID, token, socket)}))
    hookIds.push(Hooks.on('deleteAura', async (document) => {await onAuraDelete(document, sourceID, token, hookIds, socket)}))
    hookIds.push(Hooks.on('sceneChange', async () => {await onSceneChange(hookIds)}))

    document.flags = mergeObject(document.flags ?? {}, { core: { effectId: effectID} });

    Hooks.callAll('updateAura');
}

function handleTokenUpdate(document, updateData, socket) {
    // If this update contains no movement, ignore it
    if(!updateData.x && !updateData.y) return;

    Hooks.callAll("updateAura");
}

function handleItemDelete(document, updateData, socket){
    if(document.type != "effect") return;
    if(document.data.data.rules[0] == null) return;
    if(document.data.data.rules[0].key != "aura") return;

    Hooks.callAll('deleteAura', document);
}

function handleSceneLoad(document, updateData, socket){
    Hooks.callAll('sceneChange');

    console.log("Automated Auras | Handling scene change")

    let tokens = Array.from(document.scene.tokens)

    for(let t of tokens){
        let aura = t.actor.itemTypes.effect.filter(x=>x.data.data.rules.length != 0)
        aura = aura.find(x=>x.data.data.rules[0].key === "aura")
        if(aura != null) {
            registerHooks(aura, t, socket)
        }
    }


}

function registerHooks(document, token, socket){
    let sourceID = document.id;
    let effectID = document.data.data.rules[0].effect;

    let hookIds = []

    hookIds.push(Hooks.on('updateAura', async () => {await onAuraUpdate(sourceID, token, socket)}))
    hookIds.push(Hooks.on('deleteAura', async (document) => {await onAuraDelete(document, sourceID, token, hookIds, socket)}))
    hookIds.push(Hooks.on('sceneChange', async () => {await onSceneChange(hookIds)}))

    document.flags = mergeObject(document.flags ?? {}, { core: { effectId: effectID} });

    Hooks.callAll('updateAura');
}

async function onAuraUpdate(sourceID, token, socket){
    const source = token.actor.itemTypes.effect.find((e)=> e.id == sourceID);
    let effectID = source.flags.core.effectId;
    const effect = (await fromUuid(effectID)).toObject();

    let pos = canvas.grid.getCenter(token.data.x,token.data.y);
    let tokenSizePix = token.data.width * canvas.grid.size
    let radius = (((source.data.data.rules[0].radius)/canvas.grid.grid.options.dimensions.distance)*canvas.grid.size) + (tokenSizePix/2);

    let inRadius = warpgate.crosshairs.collect({
        x:pos[0],
        y:pos[1],
        radius:radius,
        scene:token.scene
    }, ["Token"]);

    let sourceDisposition = token.data.disposition
    let alliesInRadius = inRadius.Token.filter(x=>x.data.disposition === sourceDisposition);
    let allies = Array.from(token.scene.tokens).filter(x=>x.data.disposition === sourceDisposition);
    let inRadiusSet = new Set(alliesInRadius);
    let alliesOutRadius = allies.filter(x=> !inRadiusSet.has(x));

    effect.flags = mergeObject(effect.flags ?? {}, { core: { sourceId: sourceID } });

    for (const O of alliesOutRadius) {
        let onlineOwners = game.users.filter(x=> !x.isGM && x.active && O.actor.data.permission.hasOwnProperty(x.id) && O.actor.data.permission[x.id] === 3);

        if(!game.user.isGM && O.actor.isOwner){
            await removeEffectsPermisionsOptimized(O, sourceID);
        }else if (game.user.isGM && !O.actor.hasPlayerOwner) {
            await removeEffectsPermisionsOptimized(O, sourceID);
        } else if(game.user.isGM && O.actor.hasPlayerOwner && onlineOwners.length === 0){
            await removeEffectsPermisionsOptimized(O, sourceID);
        }
    }

    for (const O of alliesInRadius) {
        let onlineOwners = game.users.filter(x=> !x.isGM && x.active && O.actor.data.permission.hasOwnProperty(x.id) && O.actor.data.permission[x.id] === 3);

        if(!game.user.isGM && O.actor.isOwner){
            await addEffectsPermisionsOptimized(O, effect, sourceID);
        }else if (game.user.isGM && !O.actor.hasPlayerOwner) {
            await addEffectsPermisionsOptimized(O, effect, sourceID);
        } else if(game.user.isGM && O.actor.hasPlayerOwner && onlineOwners.length === 0){
            await addEffectsPermisionsOptimized(O, effect, sourceID);
        }
    }
}

async function addEffectsPermisionsOptimized(O, effect, sourceID){
    let existing = O.actor.itemTypes.effect.find((effect) => effect.getFlag('core', 'sourceId') === sourceID);
    if (!existing) {
        let same = O.actor.itemTypes.effect.find((e) => e.name === effect.name);
        if (!same) {
            await addEffect(O.actor, [effect]);
            cleanUp(O.actor);
        }
    }
}

async function removeEffectsPermisionsOptimized(O, sourceID){
    let existing = O.actor.itemTypes.effect.find((effect)=>effect.getFlag('core','sourceId') === sourceID);
    if (existing) {
        await removeEffect(existing)
    }
}

async function onAuraDelete(document, sourceID, token, hookIds, socket){
    console.log(document.id)
    if(document.id != sourceID) return;

    const u = hookIds[0]
    Hooks.off("updateAura", u)
    const d = hookIds[1]
    Hooks.off("deleteAura", d)
    const s = hookIds[2]
    Hooks.off("sceneChange", s)

    await RemoveEffectFromTokens(token, document, sourceID);
    Hooks.callAll('updateAura')
}

async function onSceneChange(hookIds){
    const u = hookIds[0]
    Hooks.off("updateAura", u)
    const d = hookIds[1]
    Hooks.off("deleteAura", d)
    const s = hookIds[2]
    Hooks.off("sceneChange", s)

    console.log("Removed Hooks " + u + " " + d + " " + s)
}

async function addEffect(target, effect){
    await target.createEmbeddedDocuments('Item', effect);
}

async function removeEffect(effect){
    await effect.delete();
}

async function RemoveEffectFromTokens(token, source, sourceID){
    let pos = canvas.grid.getCenter(token.data.x,token.data.y);

    let tokenSizePix = token.data.width * canvas.grid.size
    let radius = (((source.data.data.rules[0].radius)/canvas.grid.grid.options.dimensions.distance)*canvas.grid.size) + (tokenSizePix/2);

    let inRadius = warpgate.crosshairs.collect({
        x:pos[0],
        y:pos[1],
        radius:radius,
        scene:token.scene
    }, ["Token"]);

    let sourceDisposition = token.data.disposition
    let alliesInRadius = inRadius.Token.filter(x=>x.data.disposition === sourceDisposition);
    let allies = Array.from(token.scene.tokens).filter(x=>x.data.disposition === sourceDisposition);
    let inRadiusSet = new Set(alliesInRadius);
    let alliesOutRadius = allies.filter(x=> !inRadiusSet.has(x));

    for (const O of alliesOutRadius) {
        let onlineOwners = game.users.filter(x=> !x.isGM && x.active && O.actor.data.permission.hasOwnProperty(x.id) && O.actor.data.permission[x.id] === 3);

        if(!game.user.isGM && O.actor.isOwner){
            await removeEffectsPermisionsOptimized(O, sourceID);
        }else if (game.user.isGM && !O.actor.hasPlayerOwner) {
            await removeEffectsPermisionsOptimized(O, sourceID);
        } else if(game.user.isGM && O.actor.hasPlayerOwner && onlineOwners.length === 0){
            await removeEffectsPermisionsOptimized(O, sourceID);
        }
    }

    for (const O of alliesInRadius) {
        let onlineOwners = game.users.filter(x=> !x.isGM && x.active && O.actor.data.permission.hasOwnProperty(x.id) && O.actor.data.permission[x.id] === 3);

        if(!game.user.isGM && O.actor.isOwner){
            await removeEffectsPermisionsOptimized(O, sourceID);
        }else if (game.user.isGM && !O.actor.hasPlayerOwner) {
            await removeEffectsPermisionsOptimized(O, sourceID);
        } else if(game.user.isGM && O.actor.hasPlayerOwner && onlineOwners.length === 0){
            await removeEffectsPermisionsOptimized(O, sourceID);
        }
    }
}

async function cleanUp(actor){
    let effects = actor.data.items.filter(x=> x.type === "effect")
    let effectsNoDupes = [];

    for(const e of effects){
        let dupe = (effectsNoDupes.includes(e.name))
        if(dupe){
            removeEffect(e)
        }else{
            effectsNoDupes.push(e.name)
        }
    }
}

function findTokenFromActor(actor){
    let token = actor.token;
    if(token === null){
        token = actor.getActiveTokens(true, false)[0]
    }
    return token;
}
import simplifyRollFormula from "../../dice/simplify-roll-formula.mjs";

/**
 * A specialized Dialog subclass for ability usage.
 *
 * @param {Item5e} item                                Item that is being used.
 * @param {object} [dialogData={}]                     An object of dialog data which configures
 *                                                     how the modal window is rendered.
 * @param {object} [options={}]                        Dialog rendering options.
 * @param {ItemUseConfiguration} [options.usageConfig] The ability use configuration's values.
 */
export default class AbilityUseDialog extends Dialog {
  constructor(item, dialogData={}, options={}) {
    super(dialogData, options);
    this.options.classes = ["dnd5e", "dialog"];

    /**
     * Store a reference to the Item document being used
     * @type {Item5e}
     */
    this.item = item;

    /**
     * Store a reference to the ItemUseConfiguration being used
     * @type {ItemUseConfiguration}
     */
    this.configuration = options.usageConfig ?? {};
  }

  /* -------------------------------------------- */
  /*  Rendering                                   */
  /* -------------------------------------------- */

  /**
   * Configuration options for displaying the ability use dialog.
   *
   * @typedef {object} AbilityUseDialogOptions
   * @property {object} [button]
   * @property {string} [button.icon]     Icon used for the activation button.
   * @property {string} [button.label]    Label used for the activation button.
   * @property {string} [disableScaling]  Should spell or resource scaling be disabled?
   */

  /**
   * A constructor function which displays the Spell Cast Dialog app for a given Actor and Item.
   * Returns a Promise which resolves to the dialog FormData once the workflow has been completed.
   * @param {Item5e} item                           Item being used.
   * @param {ItemUseConfiguration} config           The ability use configuration's values.
   * @param {AbilityUseDialogOptions} [options={}]  Additional options for displaying the dialog.
   * @returns {Promise}                             Promise that is resolved when the use dialog is acted upon.
   */
  static async create(item, config, options={}) {
    if ( !item.isOwned ) throw new Error("You cannot display an ability usage dialog for an unowned item");
    config ??= item._getUsageConfig();

    const limit = item.actor.system.attributes?.concentration?.limit ?? 0;
    const concentrationOptions = this._createConcentrationOptions(item);
    const resourceOptions = this._createResourceOptions(item);

    const data = {
      item,
      ...config,
      slotOptions: config.consumeSpellSlot ? this._createSpellSlotOptions(item.actor, item.system.level) : [],
      summoningOptions: this._createSummoningOptions(item),
      resourceOptions: resourceOptions,
      resourceArray: Array.isArray(resourceOptions),
      concentration: {
        show: (config.beginConcentrating !== null) && !!concentrationOptions.length,
        options: concentrationOptions,
        optional: (concentrationOptions.length < limit) ? "—" : null
      },
      scaling: options.disableScaling ? null : item.usageScaling,
      note: this._getAbilityUseNote(item, config),
      title: game.i18n.format("DND5E.AbilityUseHint", {
        type: game.i18n.localize(CONFIG.Item.typeLabels[item.type]),
        name: item.name
      })
    };
    this._getAbilityUseWarnings(data, options);

    // Render the ability usage template
    const html = await renderTemplate("systems/dnd5e/templates/apps/ability-use.hbs", data);

    // Create the Dialog and return data as a Promise
    const isSpell = item.type === "spell";
    const label = game.i18n.localize(`DND5E.AbilityUse${isSpell ? "Cast" : "Use"}`);
    return new Promise(resolve => {
      const dlg = new this(item, {
        title: `${item.name}: ${game.i18n.localize("DND5E.AbilityUseConfig")}`,
        content: html,
        buttons: {
          use: {
            icon: options.button?.icon ?? `<i class="fas ${isSpell ? "fa-magic" : "fa-fist-raised"}"></i>`,
            label: options.button?.label ?? label,
            callback: html => {
              const fd = new FormDataExtended(html[0].querySelector("form"));
              resolve(fd.object);
            }
          }
        },
        default: "use",
        close: () => resolve(null)
      }, {
        usageConfig: config
      });
      dlg.render(true);
    });
  }

  /* -------------------------------------------- */
  /*  Helpers                                     */
  /* -------------------------------------------- */

  /**
   * Create an array of options for which concentration effect to end or replace.
   * @param {Item5e} item     The item being used.
   * @returns {object[]}      Array of concentration options.
   * @private
   */
  static _createConcentrationOptions(item) {
    const { effects } = item.actor.concentration;
    return effects.reduce((acc, effect) => {
      const data = effect.getFlag("dnd5e", "itemData");
      acc.push({
        name: effect.id,
        label: data?.name ?? item.actor.items.get(data)?.name ?? game.i18n.localize("DND5E.ConcentratingItemless")
      });
      return acc;
    }, []);
  }

  /* -------------------------------------------- */

  /**
   * Create an array of spell slot options for a select.
   * @param {Actor5e} actor  The actor with spell slots.
   * @param {number} level   The minimum level.
   * @returns {object[]}     Array of spell slot select options.
   * @private
   */
  static _createSpellSlotOptions(actor, level) {
    // Determine the levels which are feasible
    let lmax = 0;
    const options = Array.fromRange(Object.keys(CONFIG.DND5E.spellLevels).length).reduce((arr, i) => {
      if ( i < level ) return arr;
      const label = CONFIG.DND5E.spellLevels[i];
      const l = actor.system.spells[`spell${i}`] || {max: 0, override: null};
      let max = parseInt(l.override || l.max || 0);
      let slots = Math.clamped(parseInt(l.value || 0), 0, max);
      if ( max > 0 ) lmax = i;
      arr.push({
        key: `spell${i}`,
        level: i,
        label: i > 0 ? game.i18n.format("DND5E.SpellLevelSlot", {level: label, n: slots}) : label,
        canCast: max > 0,
        hasSlots: slots > 0
      });
      return arr;
    }, []).filter(sl => sl.level <= lmax);

    // If this character has other kinds of slots, present them as well.
    for ( const k of Object.keys(CONFIG.DND5E.spellcastingTypes) ) {
      const spellData = actor.system.spells[k];
      if ( !spellData ) continue;
      if ( spellData.level >= level ) {
        options.push({
          key: k,
          level: spellData.level,
          label: `${game.i18n.format(`DND5E.SpellLevel${k.capitalize()}`, {level: spellData.level, n: spellData.value})}`,
          canCast: true,
          hasSlots: spellData.value > 0
        });
      }
    }

    return options;
  }

  /* -------------------------------------------- */

  /**
   * Create an array of summoning profiles.
   * @param {Item5e} item  The item.
   * @returns {{ profiles: object, creatureTypes: object }|null}   Array of select options.
   */
  static _createSummoningOptions(item) {
    const summons = item.system.summons;
    if ( !summons?.profiles.length ) return null;
    const options = {};
    const rollData = item.getRollData();
    const keyPath = item.type === "spell"
      ? "item.level"
      : summons.classIdentifier
        ? `classes.${summons.classIdentifier}.levels`
        : "details.level";
    const level = foundry.utils.getProperty(rollData, keyPath) ?? 0;
    options.profiles = Object.fromEntries(
      summons.profiles
        .map(profile => {
          const doc = profile.uuid ? fromUuidSync(profile.uuid) : null;
          const withinRange = ((profile.level.min ?? -Infinity) <= level) && (level <= (profile.level.max ?? Infinity));
          if ( !doc || !withinRange ) return null;
          let label = profile.name ? profile.name : (doc?.name ?? "—");
          let count = simplifyRollFormula(Roll.replaceFormulaData(profile.count ?? "1", rollData));
          if ( Number.isNumeric(count) ) {
            count = parseInt(count);
            if ( count > 1 ) label = `${count} x ${label}`;
          } else if ( count ) label = `${count} x ${label}`;
          return [profile._id, label];
        })
        .filter(f => f)
    );
    if ( Object.values(options.profiles).length <= 1 ) {
      options.profiles = null;
      options.profile = summons.profiles[0]._id;
    }
    if ( summons.creatureSizes.size > 1 ) options.creatureSizes = summons.creatureSizes.reduce((obj, k) => {
      obj[k] = CONFIG.DND5E.actorSizes[k]?.label;
      return obj;
    }, {});
    if ( summons.creatureTypes.size > 1 ) options.creatureTypes = summons.creatureTypes.reduce((obj, k) => {
      obj[k] = CONFIG.DND5E.creatureTypes[k]?.label;
      return obj;
    }, {});
    return options;
  }

  /* -------------------------------------------- */

  /**
   * Configure resource consumption options for a select.
   * @param {Item5e} item     The item.
   * @returns {object|null}   Object of select options, or null if the item does not or cannot scale with resources.
   * @protected
   */
  static _createResourceOptions(item) {
    const consume = item.system.consume || {};
    if ( (item.type !== "spell") || !consume.scale ) return null;
    const spellLevels = Object.keys(CONFIG.DND5E.spellLevels).length - 1;

    const min = consume.amount || 1;
    const cap = spellLevels + min - item.system.level;

    let target;
    let value;
    let label;
    switch ( consume.type ) {
      case "ammo":
      case "material": {
        target = item.actor.items.get(consume.target);
        label = target?.name;
        value = target?.system.quantity;
        break;
      }
      case "attribute": {
        target = item.actor;
        value = foundry.utils.getProperty(target.system, consume.target);
        break;
      }
      case "charges": {
        target = item.actor.items.get(consume.target);
        label = target?.name;
        value = target?.system.uses.value;
        break;
      }
      case "hitDice": {
        target = item.actor;
        if ( ["smallest", "largest"].includes(consume.target) ) {
          label = game.i18n.localize(`DND5E.ConsumeHitDice${consume.target.capitalize()}Long`);
          value = target.system.attributes.hd.value;
        } else {
          value = item.actor.system.attributes.hd.bySize[consume.target] ?? 0;
          label = `${game.i18n.localize("DND5E.HitDice")} (${consume.target})`;
        }
        break;
      }
    }

    if ( !target ) return null;

    const consumesSpellSlot = consume.target.match(/spells\.([^.]+)\.value/);
    if ( consumesSpellSlot ) {
      const [, key] = consumesSpellSlot;
      const spells = item.actor.system.spells[key] ?? {};
      const level = spells.level || 0;
      const minimum = (item.type === "spell") ? Math.max(item.system.level, level) : level;
      return this._createSpellSlotOptions(item.actor, minimum);
    }

    const max = Math.min(cap, value);
    return Array.fromRange(max, 1).reduce((acc, n) => {
      if ( n >= min ) acc[n] = `[${n}/${value}] ${label ?? consume.target}`;
      return acc;
    }, {});
  }

  /* -------------------------------------------- */

  /**
   * Get the ability usage note that is displayed.
   * @param {object} item                   Data for the item being used.
   * @param {ItemUseConfiguration} config   The ability use configuration's values.
   * @returns {string}                      The note to display.
   * @private
   */
  static _getAbilityUseNote(item, config) {
    const { quantity, recharge, uses } = item.system;

    if ( !item.isActive ) return "";

    // Zero quantity
    if ( quantity <= 0 ) return game.i18n.localize("DND5E.AbilityUseUnavailableHint");

    // Abilities which use Recharge
    if ( config.consumeUsage && recharge?.value ) {
      return game.i18n.format(recharge.charged ? "DND5E.AbilityUseChargedHint" : "DND5E.AbilityUseRechargeHint", {
        type: game.i18n.localize(CONFIG.Item.typeLabels[item.type])
      });
    }

    // Does not use any resource
    if ( !uses?.per || !uses?.max ) return "";

    // Consumables
    if ( uses.autoDestroy ) {
      let str = "DND5E.AbilityUseNormalHint";
      if ( uses.value > 1 ) str = "DND5E.AbilityUseConsumableChargeHint";
      else if ( quantity > 1 ) str = "DND5E.AbilityUseConsumableQuantityHint";
      return game.i18n.format(str, {
        type: game.i18n.localize(`DND5E.Consumable${item.system.type.value.capitalize()}`),
        value: uses.value,
        quantity: quantity,
        max: uses.max,
        per: CONFIG.DND5E.limitedUsePeriods[uses.per]?.label
      });
    }

    // Other Items
    else {
      return game.i18n.format(`DND5E.AbilityUse${uses.value ? "Normal" : "Unavailable"}Hint`, {
        type: game.i18n.localize(CONFIG.Item.typeLabels[item.type]),
        value: uses.value,
        max: uses.max,
        per: CONFIG.DND5E.limitedUsePeriods[uses.per]?.label
      });
    }
  }

  /* -------------------------------------------- */

  /**
   * Get the ability usage warnings to display.
   * @param {object} data                           Template data for the AbilityUseDialog. **Will be mutated**
   * @param {AbilityUseDialogOptions} [options={}]  Additional options for displaying the dialog.
   * @private
   */
  static _getAbilityUseWarnings(data, options={}) {
    const warnings = [];
    const item = data.item;
    const { quantity, level, consume, preparation } = item.system;
    const scale = options.disableScaling ? null : item.usageScaling;
    const levels = [level];

    if ( item.type === "spell" ) {
      const spellData = item.actor.system.spells[preparation.mode] ?? {};
      if ( Number.isNumeric(spellData.level) ) levels.push(spellData.level);
    }

    if ( (scale === "slot") && data.slotOptions.every(o => !o.hasSlots) ) {
      // Warn that the actor has no spell slots of any level with which to use this item.
      warnings.push(game.i18n.format("DND5E.SpellCastNoSlotsLeft", {
        name: item.name
      }));
    } else if ( (scale === "slot") && !data.slotOptions.some(o => levels.includes(o.level) && o.hasSlots) ) {
      // Warn that the actor has no spell slots of this particular level with which to use this item.
      warnings.push(game.i18n.format("DND5E.SpellCastNoSlots", {
        level: CONFIG.DND5E.spellLevels[level],
        name: item.name
      }));
    } else if ( (scale === "resource") && foundry.utils.isEmpty(data.resourceOptions) ) {
      // Warn that the resource does not have enough left.
      warnings.push(game.i18n.format("DND5E.ConsumeWarningNoQuantity", {
        name: item.name,
        type: CONFIG.DND5E.abilityConsumptionTypes[consume.type]
      }));
    }

    // Warn that the resource item is missing.
    if ( item.hasResource ) {
      const isItem = ["ammo", "material", "charges"].includes(consume.type);
      if ( isItem && !item.actor.items.get(consume.target) ) {
        warnings.push(game.i18n.format("DND5E.ConsumeWarningNoSource", {
          name: item.name, type: CONFIG.DND5E.abilityConsumptionTypes[consume.type]
        }));
      }
    }

    // Display warnings that the item or its resource item will be destroyed.
    if ( item.type === "consumable" ) {
      const type = game.i18n.localize(`DND5E.Consumable${item.system.type.value.capitalize()}`);
      if ( this._willLowerQuantity(item) && (quantity === 1) ) {
        warnings.push(game.i18n.format("DND5E.AbilityUseConsumableDestroyHint", {type}));
      }

      const resource = item.actor.items.get(consume.target);
      const qty = consume.amount || 1;
      if ( resource && (resource.system.quantity === 1) && this._willLowerQuantity(resource, qty) ) {
        warnings.push(game.i18n.format("DND5E.AbilityUseConsumableDestroyResourceHint", {type, name: resource.name}));
      }
    }

    // Display warnings that the actor cannot concentrate on this item, or if it must replace one of the effects.
    if ( data.concentration.show ) {
      const locale = `DND5E.ConcentratingWarnLimit${data.concentration.optional ? "Optional" : ""}`;
      warnings.push(game.i18n.localize(locale));
    } else if ( data.beginConcentrating && !item.actor.system.attributes?.concentration?.limit ) {
      const locale = "DND5E.ConcentratingWarnLimitZero";
      warnings.push(game.i18n.localize(locale));
    }

    data.warnings = warnings;
  }

  /* -------------------------------------------- */

  /**
   * Get whether an update for an item's limited uses will result in lowering its quantity.
   * @param {Item5e} item       The item targeted for updates.
   * @param {number} [consume]  The amount of limited uses to subtract.
   * @returns {boolean}
   * @private
   */
  static _willLowerQuantity(item, consume=1) {
    const hasUses = item.hasLimitedUses;
    const uses = item.system.uses;
    if ( !hasUses || !uses.autoDestroy ) return false;
    const value = uses.value - consume;
    return value <= 0;
  }

  /* -------------------------------------------- */
  /*  Event Handlers                              */
  /* -------------------------------------------- */

  /** @inheritDoc */
  activateListeners(jQuery) {
    super.activateListeners(jQuery);
    const [html] = jQuery;

    html.querySelector('[name="slotLevel"]')?.addEventListener("change", this._onChangeSlotLevel.bind(this));
  }

  /* -------------------------------------------- */

  /**
   * Update summoning profiles when spell slot level is changed.
   * @param {Event} event  Triggering change event.
   */
  _onChangeSlotLevel(event) {
    const level = parseInt(event.target.value.replace("spell", ""));
    const item = this.item.clone({ "system.level": level });
    const summoningData = this.constructor._createSummoningOptions(item);
    const originalInput = this.element[0].querySelector('[name="summonsProfile"]');
    if ( !originalInput ) return;

    // If multiple profiles, replace with select element
    if ( summoningData.profiles ) {
      const select = document.createElement("select");
      select.name = "summonsProfile";
      select.ariaLabel = game.i18n.localize("DND5E.Summoning.Profile.Label");
      for ( const [id, label] of Object.entries(summoningData.profiles) ) {
        const option = document.createElement("option");
        option.value = id;
        option.innerText = label;
        if ( id === originalInput.value ) option.selected = true;
        select.append(option);
      }
      originalInput.replaceWith(select);
    }

    // If only one profile, replace with hidden input
    else {
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = "summonsProfile";
      input.value = summoningData.profile;
      originalInput.replaceWith(input);
    }
  }
}

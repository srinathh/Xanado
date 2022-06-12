/*Copyright (C) 2019-2022 The Xanado Project https://github.com/cdot/Xanado
License MIT. See README.md at the root of this distribution for full copyright
and license information*/
/* eslint-env amd, jquery */

define("game/Player", [
	"platform", "common/Debuggable", "game/Types", "game/Rack",
], (Platform, Debuggable, Types, Rack) => {

    const Timer = Types.Timer;

	// Unicode characters
	const BLACK_CIRCLE = "\u25cf";

	/**
	 * A player in a {@link Game}. Player objects are specific to
	 * a single game, and are used on both browser and server sides.
     * @extends Debuggable
	 */
	class Player extends Debuggable {

		/**
		 * Player unique key. Required.
		 * @member {Key}
		 */
		key;

		/**
		 * Player name. Required.
		 * @member {string}
		 */
		name;

		/**
		 * Player doesn't have a rack until they join a game, as
		 * it's only then we know how big it has to be.
		 * @member {Rack}
		 */
		rack;

		/**
		 * Number of times this player has passed (or swapped)
		 * since the last non-pass/swap play. Default is 0.
		 * @member {number}
		 */
		passes = 0;

		/**
		 * Player's current score. Default is 0.
		 * @member {number}
		 */
		score = 0;

		/**
		 * Player countdown clock. In games with `timerType` `TIMER_TURN`,
		 * this is the number of seconds before the player's turn times
		 * out (if they are the current player). For `TIMER_GAME` it's
		 * the number of seconds before the chess clock runs out.
         * Default is undefined. Setting and management is done in
         * {@link Game}
		 * @member {number?}
		 */
		clock;

		/**
		 * The connected flag is set when the player is created
		 * from a Player.simple structure. It is not used server-side.
         * Default is false.
		 * @member {boolean?}
		 */
		isConnected;

		/**
		 * True if this player is due to miss their next play due
		 * to a failed challenge. Default is false.
		 * @member {boolean?}
		 */
		missNextTurn;

		/**
		 * Set true to advise human player of better plays than the one
		 * they used. Default is false.
		 * @member {boolean}
		 */
		wantsAdvice;

		/**
		 * Is player a robot? Default is false.
		 * @member {boolean?}
		 */
		isRobot;

		/**
		 * Can robot player challenge? Default is false.
		 * @member {boolean?}
		 */
		canChallenge;

		/**
		 * Name of the dictionary the robot will use. Defaults to
         * the game dictionary. Only used for findBestPlay for robot players.
         * Default is undefined.
		 * @member {string?}
		 */
		dictionary;

        /**
		 * Debug function
		 * @member {function}
		 */
        _debug = () => {};

		/**
		 * @param {object} params named parameters, or other layer or simple
		 * object to copy. `name` and `key ` are required. Any of `debug`,
         * `isRobot`, `canChallenge`, `wantsAdvice`, `dictionary` or
         * `missNextTurn` can be passed to override the default.
         * `
		 */
		constructor(params) {
			this.name = params.name;
			this.key = params.key;
			if (typeof params._debug === "function")
				this._debug = params._debug;
			if (params.isRobot)
                this.isRobot = true;
			if (params.canChallenge)
                this.canChallenge = true;
            if (params.wantsAdvice)
			    this.wantsAdvice = true;
			if (params.dictionary)
                this.dictionary = params.dictionary;
			if (params.missNextTurn)
                this.missNextTurn = true;
		}

		/**
		 * Create simple flat structure describing a subset of the player
		 * state
		 * @param {Game} game the game the player is participating in
		 * @param {UserManager?} um user manager for getting emails if wanted
		 * @return {Promise} resolving to a simple structure describing the player
		 */
		simple(game, um) {
			return ((this.isRobot || !um)
					? Promise.resolve(this)
					: um.getUser({key: this.key}))
			.then(ump => {
                const simple = {
					name: this.name,
					key: this.key,
                    score: this.score
                };
                if (this.isRobot) simple.isRobot = true;
                if (this.isConnected) simple.isConnected = true;
				if (this.dictionary) simple.dictionary = this.dictionary;
                if (this.clock) simple.clock = this.clock;
					
				// Can they be emailed?
				if (ump.email) simple.email = true;

				// Is the player currently connected through a socket.
				// Set in Player.simple before transmission to the client,
				// client creates a Player(simple), which initialises
				// connected on the client. Not used server-side.
				if (this.isRobot || game.getConnection(this) !== null)
                    simple.isRobot = true;

				if (this.missNextTurn) simple.missNextTurn = true;

                return simple;
			})
			.catch(e => {
				// User key not found in the db. Not fatal, just pretend it's
				// a robot.
				return {
					name: "Unknown",
					isRobot: this.isRobot,
					dictionary: this.dictionary,
					key: this.key,
					score: this.score,
					clock: this.clock,
					isConnected: this.isRobot
					|| (game.getConnection(this) !== null)
					// A robot never misses its next turn, because its
					// challenges never fail
				};
			});
		}

		/**
		 * Draw an initial rack from the letter bag. Server side only.
		 * @param {LetterBag} letterBag LetterBag to draw tiles from
		 * @param {number} rackSize size of the rack
		 */
		fillRack(letterBag, rackSize) {
			// +1 to allow space for tile sorting in the UI
			// Use the player key for the rack id, so we can maintain
			// unique racks for different players
			this.rack = new Rack(`Rack_${this.key}`, rackSize + 1);
			for (let i = 0; i < rackSize; i++)
				this.rack.addTile(letterBag.getRandomTile());
			this.score = 0;
		}

		/**
		 * Return all tiles to the letter bag
		 */
		returnTiles(letterBag) {
			for (let tile of this.rack.tiles())
				letterBag.returnTile(this.rack.removeTile(tile));
		}

		/**
		 * Handle a tick of the server clock.
		 */
		tick() {
			this.clock--;
			this._debug("Tick", this.name, this.clock);
			if (this.clock <= 0 && typeof this._onTimeout === "function") {
				this._debug(`${this.name} has timed out at ${Date.now()}`);
				this._onTimeout();
				// Timeout only happens once!
				delete this._onTimeout;
			}
		}

		/**
		 * Set a timeout for the player, which will be triggered when the
		 * clock reaches exactly 0. The timeout is only triggered once for
		 * a call to setTimeout, resetting the clock will not invoke it
		 * again.
		 * @param {number} time number of seconds before timeout
		 * @param {function} onTimeout a function() invoked if the
		 * timer expires, ignored if time undefined
		 */
		setTimeout(time, onTimeout) {
			this._debug(`${this.name} turn timeout in ${time}s`);
			this.clock = time;
			this._onTimeout = onTimeout;
		}

		/**
         * @override
		 */
		toString() {
			let s = `Player '${this.name}'`;
			if (this.isRobot)
				s += " (Robot)";
			if (this.key)
				s += ` key ${this.key}`;
			return s;
		}

		/**
		 * Toggle wantsAdvice on/off
		 */
		toggleAdvice() {
			this.wantsAdvice = !this.wantsAdvice;
		}

		/**
		 * Create score table row for the player. This must work both
		 * on a full Player object, and also when called statically on
		 * a Player.simple
		 * @param {Player?} curPlayer the current player in the UI
		 * @return {jQuery} jQuery object for the score table
		 */
		$ui(curPlayer) {
			const $tr = $(`<tr id="player${this.key}"></tr>`)
				  .addClass("player-row");
			if (curPlayer && this.key === curPlayer.key)
				$tr.addClass("whosTurn");
			$tr.append(`<td class="turn-pointer">&#10148;</td>`);
			const $icon = $('<div class="ui-icon"></div>');
			$icon.addClass(this.isRobot ? "icon-robot" : "icon-person");
			$tr.append($("<td></td>").append($icon));
			const who = curPlayer && this.key === curPlayer.key
				? Platform.i18n("You") : this.name;
			const $name = $(`<td class="player-name">${who}</td>`);
			if (this.missNextTurn)
				$name.addClass("miss-turn");
			$tr.append($name);
			$tr.append('<td class="remaining-tiles"></td>');

			// Robots are always connected
			const $status = $(`<td class='connect-state'>${BLACK_CIRCLE}</td>`);
			$status.addClass(
                this.isConnected || this.isRobot ? "online" : "offline");
			$tr.append($status);
			
			$tr.append(`<td class='score'>${this.score}</td>`);
			$tr.append(`<td class='player-clock'></td>`);

			return $tr;
		}

		/**
		 * Refresh score table representation of the player on the browser
		 * side only.
		 */
		$refresh() {
			$(`#player${this.key} .score`).text(this.score);
		}

		/**
		 * Set 'online' status of player in UI on the browser
		 * side only.
		 * @param {boolean} tf true/false
		 */
		online(tf) {
            const conn = this.isRobot || tf;
			if (!this.isRobot)
                this.isConnected = conn;
			let rem = conn ? "offline" : "online";
			let add = conn ? "online" : "offline";
			$(`#player${this.key} .connect-state`)
			.removeClass(rem)
			.addClass(add);
		}
	}

	return Player;
});

/* See README.md at the root of this distribution for copyright and
   license information */
/* eslint-env amd, jquery */

define('game/Player', [
	'platform', 'game/GenKey', 'game/Rack',
], (
	Platform, GenKey, Rack
) => {

	// Unicode characters
	const BLACK_CIRCLE = '\u25cf';

	/**
	 * A player in a {@link Game}. Player objects are specific to
	 * a single game, and are used on both browser and server sides.
	 */
	class Player {

		/**
		 * @param {object} params named parameters, or other layer or simple
		 *  object to copy
		 * @param {(string|Player)} params.name name of the player, or
		 * a Player object to copy
		 * @param {boolean} params.key unique key identifying the player. Names
		 * may be duplicated, but keys never are.
		 * @param {boolean} params.isRobot if name is a string and true then
		 * it's a robot. If name is a Player object, ignored.
		 * @param {boolean} params.canChallenge controls whether this player
		 * can challenge if it's a robot
		 * @param {string} params.dictionary dictionary to use to find moves
		 * if this is a robot
		 * @param {boolean} params.missNextTurn true if this player
		 * has to miss their next turn due to a failed challenge
		 * @param {boolean} params._debug true to enable debug messages
		 */
		constructor(params) {
			/**
			 * Debug log messages on/off
			 * @member {boolean}
			 * @private
			 */
			this._debug = params.debug;

			/**
			 * Player unique key
			 * @member {string}
			 */
			this.key = params.key;

			/**
			 * Is player a robot?
			 * @member {boolean}
			 */
			this.isRobot = params.isRobot;

			/**
			 * If isRobot, can it challenge?
			 * @member {boolean}
			 */
			this.canChallenge = params.canChallenge;

			/**
			 * Player name
			 * @member {string}
			 */
			this.name = params.name;

			/**
			 * Player doesn't have a rack until they join a game, as
			 * it's only then we know how big it has to be.
			 * @member {Rack}
			 */
			this.rack = null;

			/**
			 * Number of times this player has passed (or swapped)
			 * @member {number}
			 */
			this.passes = 0;

			/**
			 * Set true to advise player of better plays than the one
			 * they used
			 * @member {boolean}
			 */
			this.wantsAdvice = params.wantsAdvice;

			/**
			 * Player's current score
			 * @member {number}
			 */
			this.score = 0;

			/**
			 * Seconds remaining before play times out
			 * @member {number}
			 */
			this.secondsToPlay = 0;

			/**
			 * We don't keep a pointer to the dictionary objects so we can
			 * cheaply serialise and send to the games interface. We just
			 * keep the name of the relevant object. This dictionary will
			 * only be used for findBestPlay for robot players.
			 * @member {string}
			 */
			this.dictionary = params.dictionary;

			/**
			 * True if this player is due to miss their next play due
			 * to a failed challenge
			 * @member {boolean?}
			 */
			this.missNextTurn = params.missNextTurn;

			/**
			 * The connected flag is set when the player is created
			 * from a Player.simple structure. It is not used server-side.
			 * @member {boolean?}
			 */
			if (params.isConnected)
				this.isConnected = true;
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
				return {
					name: this.name || 'Unknown Player',
					isRobot: this.isRobot,
					dictionary: this.dictionary,
					key: this.key,
					score: this.score,
					secondsToPlay: this.secondsToPlay,
					
					// Can they be emailed?
					email: ump.email ? true : false,

					// Is the player currently connected through a socket.
					// Set in Player.simple before transmission to the client,
					// client creates a Player(simple), which initialises
					// connected on the client. Not used server-side.
					isConnected: this.isRobot
					|| (game.getConnection(this) !== null),

					missNextTurn: this.missNextTurn
				};
			})
			.catch(e => {
				// User key not found in the db. Not fatal, just pretend it's
				// a robot.
				return {
					name: 'Unknown',
					isRobot: this.isRobot,
					dictionary: this.dictionary,
					key: this.key,
					score: this.score,
					secondsToPlay: this.secondsToPlay,
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
		 * Set a play timeout for the player. If the 
		 * @param {number?} time number of seconds before elapse, or
		 * 0 to cancel any timeout. If undefined, will restart the timer with
		 * the time remaining to the player.
		 * @param {function?} onTimeout a function() invoked if the
		 * timer expires, ignored if time undefined
		 */
		startTimer(time, onTimeout) {
			if (typeof time !== 'undefined') {
				this.stopTimer();
				// Timer is being reset
				if (time === 0)
					// No timeout, nothing to do
					return;
				this._onTimeout = onTimeout;
			} else if (!this._timeoutTimer && this.secondsToPlay > 0) {
				// Timer was never started of was previously stopped in
				// stopTimer, and there is time remaining. Restart the
				// timer with the outstanding seconds.
				time = this.secondsToPlay;
			} else {
				// Timer is running
				if (this.secondsToPlay <= 0)
					this.stopTimer();
				// Otherwise let the timer run on
				return;
			}

			if (this.debug)
				console.debug(`${this.name}'s go will time out in ${time}s`);

			// Set an overriding timeout
			this.secondsToPlay = time;
			this._timeoutAt = Date.now() + time * 1000;
			this._timeoutTimer = setTimeout(() => {
				this._timeoutTimer = null;
				if (this.debug)
					console.debug(`${this.name} has timed out at ${Date.now()}`);
				// Invoke the timeout function
				if (typeof this._onTimeout === 'function')
					this._onTimeout();
			}, time * 1000);
		}

		/**
		 * Cancel current play timeout
		 */
		stopTimer() {
			if (this._timeoutTimer) {
				this.secondsToPlay = Math.ceil(
					(this._timeoutAt - Date.now()) / 1000);
				if (this.debug)
					console.debug(`${this.name} stopped timer with ${this.secondsToPlay}s remaining`);
				clearTimeout(this._timeoutTimer);
				this._timeoutTimer = null;
			}
		}

		/**
		 * Generate a simple string representation of the player
		 */
		toString() {
			let s = `Player '${this.name}'`;
			if (this.isRobot)
				s += ' (Robot)';
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
			const $tr = $(`<tr id='player${this.key}'></tr>`)
				  .addClass("player-row");
			if (curPlayer && this.key === curPlayer.key)
				$tr.addClass('whosTurn');
			$tr.append(`<td class='turn-pointer'>&#10148;</td>`);
			const $icon = $('<div class="ui-icon"></div>');
			$icon.addClass(this.isRobot ? "icon-robot" : "icon-person");
			$tr.append($("<td></td>").append($icon));
			const who = curPlayer && this.key === curPlayer.key
				? Platform.i18n("You")
				  : this.name;
			const $name = $(`<td class='player-name'>${who}</td>`);
			if (this.missNextTurn)
				$name.addClass("miss-turn");
			$tr.append($name);
			$tr.append('<td class="remaining-tiles"></td>');

			// Robots are always connected
			const $status = $(`<td class='connect-state'>${BLACK_CIRCLE}</td>`);
			$status.addClass(this.isConnected ? "online" : "offline");
			$tr.append($status);
			
			$tr.append(`<td class='score'>${this.score}</td>`);

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
			this.isConnected = tf;
			let rem = tf ? 'offline' : 'online';
			let add = tf ? 'online' : 'offline';
			$(`#player${this.key} .connect-state`)
			.removeClass(rem)
			.addClass(add);
		}
	}

	return Player;
});

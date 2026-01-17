(() => {
	// Canvas setup is wrapped inside an IIFE so we do not leak globals onto the page.
	const canvas = document.getElementById("fishtank");
	if (!canvas) return;
	const context = canvas.getContext("2d");

	// Core state containers used across the animation loop.
	const fishes = [];
	const cursor = { x: Number.MAX_VALUE, y: Number.MAX_VALUE };
	let speedBoostCountdown = 200;
	let speedBoost = 0;

	// Tunable flocking constants. Keeping them grouped makes it easy to balance motion later.
	const SPEED_BOOST = 2;
	const FISH_COUNT = 100;
	const FISH_COLOR = "#00e468";
	const NEIGHBOR_RADIUS = 100;
	const SEPARATION_RADIUS = 25;
	const CURSOR_REPULSE_RADIUS = 100;
	const EDGE_PADDING = 80;
	const MAX_SPEED = 1.35;
	const MIN_SPEED = 0.2;
	const MAX_FORCE = 0.03;
	const WANDER_FORCE = 0.01;

	let tankWidth = canvas.width;
	let tankHeight = canvas.height;

	// Resize logic keeps the canvas resolution and existing fish positions in sync with layout changes.
	const resizeTank = () => {
		const rect = canvas.parentElement.getBoundingClientRect();
		const targetWidth = Math.round(rect.width);
		const targetHeight = Math.round(parseFloat(getComputedStyle(canvas).height) || canvas.height);
		const ratioX = targetWidth && tankWidth ? targetWidth / tankWidth : 1;
		const ratioY = targetHeight && tankHeight ? targetHeight / tankHeight : 1;
		tankWidth = targetWidth || tankWidth;
		tankHeight = targetHeight || tankHeight;
		canvas.width = tankWidth;
		canvas.height = tankHeight;
		fishes.forEach((fish) => {
			fish.x *= ratioX;
			fish.y *= ratioY;
		});
	};

	resizeTank();
	window.addEventListener("resize", resizeTank);

	// Utility helpers shared across the flocking calculations.
	const py = (a, b) => Math.sqrt(a * a + b * b);
	const limitVector = (x, y, max) => {
		const magnitude = py(x, y);
		if (magnitude === 0 || magnitude <= max) {
			return { x, y };
		}
		const scale = max / magnitude;
		return { x: x * scale, y: y * scale };
	};

	// Converts a raw target vector into a steering impulse that slowly nudges a fish toward that direction.
	const steerToward = (targetX, targetY, velocityX, velocityY, forceLimit, weight = 1) => {
		const desiredMagnitude = py(targetX, targetY);
		if (desiredMagnitude === 0) {
			return { x: 0, y: 0 };
		}
		const desiredX = (targetX / desiredMagnitude) * MAX_SPEED;
		const desiredY = (targetY / desiredMagnitude) * MAX_SPEED;
		const steer = limitVector(desiredX - velocityX, desiredY - velocityY, forceLimit);
		return { x: steer.x * weight, y: steer.y * weight };
	};

	// Each fish tracks its position, velocity, and wander state so we can render motion plus subtle tail wiggles.
	const Fish = function () {
		this.ox = this.dx = (Math.random() - 0.5) * 1.2;
		this.oy = this.dy = (Math.random() - 0.5) * 1.2;
		this.x = canvas.width * Math.random();
		this.y = canvas.height * Math.random();
		this.angle = 0;
		this.wanderAngle = Math.random() * Math.PI * 2;
	};

	Fish.prototype.calc = function () {
		this.ox = this.dx;
		this.oy = this.dy;

		let alignmentX = 0;
		let alignmentY = 0;
		let cohesionX = 0;
		let cohesionY = 0;
		let separationX = 0;
		let separationY = 0;
		let neighborCount = 0;

		// Sweep through every other fish and collect steering hints.
		for (let i = 0; i < fishes.length; i++) {
			const other = fishes[i];
			if (other === this) continue;
			const distance = py(this.x - other.x, this.y - other.y);
			if (distance === 0 || distance > NEIGHBOR_RADIUS) continue;
			alignmentX += other.dx;
			alignmentY += other.dy;
			cohesionX += other.x;
			cohesionY += other.y;
			neighborCount++;
			if (distance < SEPARATION_RADIUS) {
				separationX += (this.x - other.x) / distance;
				separationY += (this.y - other.y) / distance;
			}
		}

		let steerX = 0;
		let steerY = 0;

		if (neighborCount > 0) {
			alignmentX /= neighborCount;
			alignmentY /= neighborCount;
			const alignmentForce = steerToward(alignmentX, alignmentY, this.dx, this.dy, MAX_FORCE, 0.8);
			steerX += alignmentForce.x;
			steerY += alignmentForce.y;

			cohesionX = cohesionX / neighborCount - this.x;
			cohesionY = cohesionY / neighborCount - this.y;
			const cohesionForce = steerToward(cohesionX, cohesionY, this.dx, this.dy, MAX_FORCE, 0.6);
			steerX += cohesionForce.x;
			steerY += cohesionForce.y;

			const separationForce = limitVector(separationX, separationY, MAX_FORCE * 1.4);
			steerX += separationForce.x;
			steerY += separationForce.y;
		}

		// Soft walls keep the school roughly centered instead of escaping off-canvas.
		const edgeForce = 0.0009;
		if (this.x < EDGE_PADDING) {
			steerX += (EDGE_PADDING - this.x) * edgeForce;
		} else if (this.x > canvas.width - EDGE_PADDING) {
			steerX -= (this.x - (canvas.width - EDGE_PADDING)) * edgeForce;
		}
		const verticalPadding = EDGE_PADDING * 0.6;
		if (this.y < verticalPadding) {
			steerY += (verticalPadding - this.y) * edgeForce;
		} else if (this.y > canvas.height - verticalPadding) {
			steerY -= (this.y - (canvas.height - verticalPadding)) * edgeForce;
		}

		// Cursor interactions simulate a curious diver gently nudging the school away.
		let fleeBoost = 0;
		if (cursor.x !== Number.MAX_VALUE && cursor.y !== Number.MAX_VALUE) {
			const cursorDistance = py(this.x - cursor.x, this.y - cursor.y);
			if (cursorDistance > 0 && cursorDistance < CURSOR_REPULSE_RADIUS) {
				const strength = (CURSOR_REPULSE_RADIUS - cursorDistance) / CURSOR_REPULSE_RADIUS;
				steerX += ((this.x - cursor.x) / cursorDistance) * strength * 0.5;
				steerY += ((this.y - cursor.y) / cursorDistance) * strength * 0.5;
				fleeBoost = strength * 2;
			}
		}

		// Wander adds just enough noise so clusters do not freeze into straight lines.
		this.wanderAngle += (Math.random() - 0.5) * 0.2;
		steerX += Math.cos(this.wanderAngle) * WANDER_FORCE;
		steerY += Math.sin(this.wanderAngle) * WANDER_FORCE;

		this.dx += steerX;
		this.dy += steerY;

		// Clamp velocities so the fish never snap or stall.
		const speed = py(this.dx, this.dy);
		const maxSpeed = MAX_SPEED + speedBoost + fleeBoost;
		if (speed > maxSpeed) {
			const scale = maxSpeed / speed;
			this.dx *= scale;
			this.dy *= scale;
		} else if (speed < MIN_SPEED) {
			const scale = MIN_SPEED / (speed || 1);
			this.dx *= scale;
			this.dy *= scale;
		}

		this.x += this.dx;
		this.y += this.dy;
		this.angle = Math.atan2(this.dy, this.dx);
	};

	const draw = (fish) => {
		// Rotate the sprite so the fish always faces its velocity vector.
		const r = fish.angle + Math.PI;
		context.save();
		context.translate(fish.x, fish.y);
		context.rotate(r);

		// Quick squish-and-stretch gives the illusion of fin movement when accelerating.
		let w = 20;
		const acc = py(fish.dx - fish.ox, fish.dy - fish.oy) / 0.05;
		if (acc > 1) {
			w = 10 + 10 / acc;
		}

		const source = tintedFishBitmap || fishBitmap;
		context.drawImage(source, 0, 0, w, 6);
		context.restore();
	};

	const activateSpeedBoost = () => {
		// Occasional bursts keep groups from feeling deterministic—think of it as surge from a ripple.
		speedBoostCountdown = 400 + Math.round(400 * Math.random());
		speedBoost = SPEED_BOOST;
	};

	const handlePointer = (event) => {
		const rect = canvas.getBoundingClientRect();
		cursor.x = event.clientX - rect.left;
		cursor.y = event.clientY - rect.top;
	};

	const clearCursor = () => {
		cursor.x = cursor.y = Number.MAX_VALUE;
	};

	document.addEventListener("mousemove", handlePointer);
	document.addEventListener("mouseout", clearCursor);
	document.addEventListener("mousedown", activateSpeedBoost);

	const update = () => {
		// Gradually spawn up to the target school size so the canvas does not stutter on load.
		if (fishes.length < FISH_COUNT) {
			fishes.push(new Fish());
		}

		context.clearRect(0, 0, canvas.width, canvas.height);
		for (let i = 0; i < fishes.length; i++) {
			const fish = fishes[i];
			fish.calc();
			draw(fish);
		}

		speedBoostCountdown--;
		if (speedBoostCountdown < 0) {
			activateSpeedBoost();
		}
		if (speedBoost > 0) {
			speedBoost -= SPEED_BOOST / 80;
		} else {
			speedBoost = 0;
		}

		requestAnimationFrame(update);
	};

	const tintFishSprite = () => {
		const spriteCanvas = document.createElement("canvas");
		spriteCanvas.width = fishBitmap.width;
		spriteCanvas.height = fishBitmap.height;
		const spriteContext = spriteCanvas.getContext("2d");
		spriteContext.clearRect(0, 0, spriteCanvas.width, spriteCanvas.height);
		spriteContext.drawImage(fishBitmap, 0, 0);
		spriteContext.globalCompositeOperation = "source-atop";
		spriteContext.fillStyle = FISH_COLOR;
		spriteContext.fillRect(0, 0, spriteCanvas.width, spriteCanvas.height);
		spriteContext.globalCompositeOperation = "source-over";
		return spriteCanvas;
	};

	let tintedFishBitmap;
	const fishBitmap = new Image();
	fishBitmap.onload = () => {
		tintedFishBitmap = tintFishSprite();
		update();
	};
	fishBitmap.src = "img/fish.png";
})();

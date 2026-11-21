(() => {
  const TAU = Math.PI * 2;
  const random = (min, max) => min + Math.random() * (max - min);

  class DecorationEngine {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas?.getContext('2d', { alpha: true });
      this.mode = 'snow';
      this.width = 0;
      this.height = 0;
      this.dpr = 1;
      this.time = 0;
      this.lastTime = performance.now();
      this.particles = [];
      this.reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
      this.boundResize = () => this.resize();
      window.addEventListener('resize', this.boundResize, { passive: true });
      this.resize();
      requestAnimationFrame((time) => this.frame(time));
    }

    resize() {
      this.width = Math.max(320, window.innerWidth);
      this.height = Math.max(240, window.innerHeight);
      this.dpr = Math.min(window.devicePixelRatio || 1, 1.25);
      if (!this.canvas || !this.ctx) return;
      this.canvas.width = Math.round(this.width * this.dpr);
      this.canvas.height = Math.round(this.height * this.dpr);
      this.canvas.style.width = `${this.width}px`;
      this.canvas.style.height = `${this.height}px`;
      this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      this.resetParticles();
    }

    setMode(mode) {
      this.mode = mode === 'paper' ? 'paper' : 'snow';
      this.resetParticles();
    }

    resetParticles() {
      const density = this.reduceMotion ? 0.45 : 1;
      const count = Math.round((this.width < 700 ? 48 : 82) * density);
      this.particles = Array.from({ length: count }, () => this.mode === 'snow' ? this.makeSnowflake(true) : this.makePaper(true));
    }

    makeSnowflake(initial = false) {
      const size = random(1.2, this.width < 700 ? 3.3 : 4.6);
      return { x: random(-20, this.width + 20), y: initial ? random(-this.height, this.height) : random(-80, -8), vx: random(-5, 5), vy: random(28, 62), size, alpha: random(0.28, 0.86), phase: random(0, Math.PI * 2), sway: random(0.6, 1.45), spin: random(-1.2, 1.2), angle: random(0, Math.PI * 2), detailed: size > 2.4 && Math.random() > 0.48 };
    }

    makePaper(initial = false) {
      return { x: random(-40, this.width + 40), y: initial ? random(-this.height, this.height) : random(-70, -12), vx: random(-10, 10), vy: random(12, 24), size: random(9, 20), angle: random(0, TAU), spin: random(-0.65, 0.65), phase: random(0, TAU), alpha: random(0.22, 0.55), tint: Math.random() > 0.5 ? '#fff0c8' : '#e7f2ff' };
    }

    disturbSnow() {}
    refreshSurfaces() {}

    updateSnowflake(flake, dt) {
      flake.phase += flake.sway * dt;
      flake.angle += flake.spin * dt;
      const wind = Math.sin(this.time * 0.00075 + flake.phase) * 11 + Math.sin(this.time * 0.00016) * 4;
      flake.vx += (wind - flake.vx) * Math.min(1, dt * 0.9);
      flake.vy = Math.min(75, flake.vy + 5 * dt);
      flake.x += flake.vx * dt;
      flake.y += flake.vy * dt;
      if (flake.x < -30) flake.x = this.width + 20;
      if (flake.x > this.width + 30) flake.x = -20;
      if (flake.y > this.height + 25) Object.assign(flake, this.makeSnowflake(false));
    }

    updatePaper(paper, index, dt) {
      paper.phase += 0.9 * dt;
      paper.angle += paper.spin * dt;
      paper.vx += (Math.sin(paper.phase + index) * 8 - paper.vx) * Math.min(1, dt * 0.45);
      paper.vy = Math.min(26, paper.vy + 4 * dt);
      paper.x += paper.vx * dt;
      paper.y += paper.vy * dt;
      if (paper.y > this.height + 45 || paper.x < -80 || paper.x > this.width + 80) Object.assign(paper, this.makePaper(false));
    }

    drawSnowflake(flake) {
      const ctx = this.ctx;
      ctx.save();
      ctx.translate(flake.x, flake.y);
      ctx.rotate(flake.angle);
      ctx.globalAlpha = flake.alpha;
      ctx.fillStyle = '#fff';
      if (!flake.detailed) {
        ctx.beginPath();
        ctx.arc(0, 0, flake.size, 0, TAU);
        ctx.fill();
      } else {
        ctx.strokeStyle = 'rgba(255,255,255,.88)';
        ctx.lineWidth = Math.max(0.6, flake.size * 0.16);
        ctx.lineCap = 'round';
        for (let branch = 0; branch < 6; branch += 1) {
          const angle = (TAU / 6) * branch;
          const length = flake.size * 1.7;
          ctx.beginPath();
          ctx.moveTo(0, 0);
          ctx.lineTo(Math.cos(angle) * length, Math.sin(angle) * length);
          ctx.stroke();
        }
      }
      ctx.restore();
    }

    drawPaper(paper) {
      const ctx = this.ctx;
      ctx.save();
      ctx.translate(paper.x, paper.y);
      ctx.rotate(paper.angle);
      ctx.globalAlpha = paper.alpha;
      ctx.fillStyle = paper.tint;
      ctx.strokeStyle = 'rgba(187,145,83,.25)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(-paper.size * .58, -paper.size * .34);
      ctx.lineTo(paper.size * .55, -paper.size * .2);
      ctx.lineTo(paper.size * .35, paper.size * .42);
      ctx.lineTo(-paper.size * .62, paper.size * .25);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }

    render() {
      if (!this.ctx) return;
      this.ctx.clearRect(0, 0, this.width, this.height);
      if (this.mode === 'snow') this.particles.forEach((flake) => this.drawSnowflake(flake));
      else this.particles.forEach((paper) => this.drawPaper(paper));
    }

    frame(time) {
      const dt = Math.min(0.034, Math.max(0.001, (time - this.lastTime) / 1000 || 0.016));
      this.lastTime = time;
      if (!document.hidden) {
        this.time += dt * 1000;
        if (this.mode === 'snow') this.particles.forEach((flake) => this.updateSnowflake(flake, dt));
        else this.particles.forEach((paper, index) => this.updatePaper(paper, index, dt));
        this.render();
      }
      requestAnimationFrame((nextTime) => this.frame(nextTime));
    }
  }

  window.DecorationEngine = DecorationEngine;
})();

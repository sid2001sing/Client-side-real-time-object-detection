import { Component, ElementRef, ViewChild, OnInit, NgZone, OnDestroy, inject } from '@angular/core';
import { CommonModule } from '@angular/common';

declare var cocoSsd: any;
declare var tf: any;

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="app-container">
      <h1>Object Detection (Camera First)</h1>

      <div class="video-wrapper">
        <!-- 1. Video Layer (Always Visible) -->
        <video #videoElement autoplay muted playsinline></video>
        
        <!-- 2. Canvas Layer (Drawing) -->
        <canvas #canvasElement></canvas>
        
        <!-- 3. AI Status Overlay (Non-Blocking) -->
        <div *ngIf="isAiLoading" class="ai-status-pill">
          <div class="mini-spinner"></div>
          <span>{{ statusMessage }}</span>
        </div>

        <div class="fps-badge" *ngIf="!isAiLoading">
          AI Active | {{ fps }} FPS
        </div>

        <!-- 4. Error Overlay (Only if AI totally fails) -->
        <div *ngIf="hasError" class="error-overlay">
          <p>⚠️ {{ errorMessage }}</p>
          <button (click)="retryAiLoad()" class="btn-small">Retry AI</button>
        </div>
      </div>

      <div class="controls">
        <button (click)="toggleCamera()" class="btn main-btn" [class.running]="isCameraRunning">
          {{ isCameraRunning ? 'STOP CAMERA' : 'START CAMERA' }}
        </button>
      </div>
      
      <div class="logs">
        <div *ngFor="let log of logs" class="log-line">{{ log }}</div>
      </div>
    </div>
  `,
  styles: [`
    .app-container { 
      font-family: 'Segoe UI', sans-serif; background: #111; color: white;
      min-height: 100vh; display: flex; flex-direction: column; align-items: center; padding: 20px;
    }
    
    .video-wrapper {
      position: relative; background: #000; border: 2px solid #333; border-radius: 8px; overflow: hidden;
      width: 640px; height: 480px; margin-bottom: 20px;
    }
    
    /* Mirror Video */
    video { position: absolute; width: 100%; height: 100%; object-fit: cover; transform: scaleX(-1); }
    canvas { position: absolute; width: 100%; height: 100%; object-fit: cover; }

    /* Non-Intrusive Loading Pill */
    .ai-status-pill {
      position: absolute; bottom: 20px; left: 50%; transform: translateX(-50%);
      background: rgba(0, 0, 0, 0.8); padding: 8px 16px; border-radius: 20px;
      display: flex; align-items: center; gap: 10px; border: 1px solid #444;
      font-size: 14px; color: #ccc; z-index: 10;
    }

    .mini-spinner {
      width: 16px; height: 16px; border: 2px solid #666; border-top-color: #00d2ff;
      border-radius: 50%; animation: spin 1s infinite linear;
    }
    
    .error-overlay {
      position: absolute; top: 0; left: 0; right: 0; background: rgba(220, 53, 69, 0.9);
      color: white; padding: 10px; text-align: center; z-index: 20;
    }

    .fps-badge { 
      position: absolute; top: 10px; right: 10px; background: rgba(0,255,0,0.8); 
      color: black; padding: 4px 8px; border-radius: 4px; font-weight: bold; font-size: 12px;
    }

    @keyframes spin { to { transform: rotate(360deg); } }

    .btn { padding: 12px 24px; border: none; border-radius: 4px; font-weight: bold; cursor: pointer; }
    .main-btn { background: #007bff; color: white; font-size: 16px; width: 200px; }
    .main-btn.running { background: #dc3545; }
    .btn-small { background: white; color: red; border: none; padding: 4px 8px; border-radius: 4px; cursor: pointer; margin-left: 10px; }
    
    .logs { width: 640px; height: 120px; overflow-y: auto; background: #1a1a1a; padding: 10px; font-family: monospace; font-size: 12px; color: #aaa; text-align: left; border: 1px solid #333; }
    .log-line { border-bottom: 1px solid #222; padding: 2px 0; }
  `]
})
export class AppComponent implements OnInit, OnDestroy {
  @ViewChild('videoElement') videoRef!: ElementRef<HTMLVideoElement>;
  @ViewChild('canvasElement') canvasRef!: ElementRef<HTMLCanvasElement>;
  
  private ngZone = inject(NgZone);

  // 1. URLs (Pinned for stability)
  readonly TF_URL = 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.17.0/dist/tf.min.js';
  readonly COCO_URL = 'https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3/dist/coco-ssd.min.js';

  // State
  isCameraRunning = false;
  isAiLoading = true;
  hasError = false;
  statusMessage = 'Starting Camera...';
  errorMessage = '';
  fps = 0;
  logs: string[] = [];

  // Internals
  model: any = null;
  animationId: number | null = null;
  lastRun = 0;

  async ngOnInit() {
    this.log('Initializing...');
    
    // STEP 1: Start Camera IMMEDIATELY
    await this.startCamera();
    
    // STEP 2: Load AI in Background (Non-Blocking)
    this.loadAiEngine();
  }

  log(msg: string) {
    this.ngZone.run(() => {
      const time = new Date().toLocaleTimeString().split(' ')[0];
      this.logs.unshift(`[${time}] ${msg}`);
      if (this.logs.length > 50) this.logs.pop();
    });
  }

  // --- CAMERA LOGIC (Priority #1) ---
  async toggleCamera() {
    this.isCameraRunning ? this.stopCamera() : await this.startCamera();
  }

  async startCamera() {
    try {
      this.log('Requesting Camera Access...');
      const stream = await navigator.mediaDevices.getUserMedia({ 
        video: { width: 640, height: 480 } 
      });

      const video = this.videoRef.nativeElement;
      video.srcObject = stream;
      
      video.onloadeddata = () => {
        // Force Canvas Sync
        const canvas = this.canvasRef.nativeElement;
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        
        this.isCameraRunning = true;
        this.log('Camera Active. Video playing.');
        
        // Start Loop (Even if AI isn't ready, loop runs to keep FPS counting)
        this.ngZone.runOutsideAngular(() => this.detectLoop());
      };

    } catch (err: any) {
      alert('Camera Error: ' + err.message);
      this.log('Camera Failed: ' + err.message);
    }
  }

  stopCamera() {
    this.isCameraRunning = false;
    const video = this.videoRef.nativeElement;
    if (video.srcObject) {
      const stream = video.srcObject as MediaStream;
      stream.getTracks().forEach(t => t.stop());
      video.srcObject = null;
    }
    const canvas = this.canvasRef.nativeElement;
    const ctx = canvas.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    this.log('Camera Stopped.');
  }

  // --- AI LOADING LOGIC (Background Priority) ---
  retryAiLoad() {
    this.hasError = false;
    this.loadAiEngine();
  }

  async loadAiEngine() {
    this.isAiLoading = true;
    this.hasError = false;

    try {
      // 1. Download TFJS
      this.statusMessage = 'Downloading AI Engine...';
      if (typeof tf === 'undefined') {
        await this.loadScript(this.TF_URL);
      }
      this.log('TensorFlow.js loaded.');

      // 2. Download COCO-SSD
      this.statusMessage = 'Downloading Model Definition...';
      if (typeof cocoSsd === 'undefined') {
        await this.loadScript(this.COCO_URL);
      }
      this.log('COCO-SSD loaded.');

      // 3. Init Backend (Force CPU fallback if needed)
      this.statusMessage = 'Initializing Neural Network...';
      try {
        await tf.setBackend('webgl');
        await tf.ready();
        this.log('WebGL Backend Active.');
      } catch (e) {
        console.warn('WebGL failed, falling back to CPU');
        await tf.setBackend('cpu');
        this.log('CPU Backend Active (Backup Mode).');
      }

      // 4. Load Model
      this.statusMessage = 'Fetching Intelligence (2MB)...';
      // 'lite_mobilenet_v2' is fastest
      this.model = await cocoSsd.load({ base: 'lite_mobilenet_v2' });
      
      this.statusMessage = 'AI Ready';
      this.isAiLoading = false;
      this.log('AI Engine Online & Ready to Detect.');

    } catch (err: any) {
      console.error(err);
      this.hasError = true;
      this.isAiLoading = false;
      this.errorMessage = 'AI Load Failed. Check Internet.';
      this.log('Critical AI Error: ' + err.message);
    }
  }

  loadScript(src: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
      const script = document.createElement('script');
      script.src = src;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error(`Failed to load ${src}`));
      document.body.appendChild(script);
    });
  }

  // --- DETECTION LOOP ---
  async detectLoop() {
    if (!this.isCameraRunning) return;

    const video = this.videoRef.nativeElement;
    const canvas = this.canvasRef.nativeElement;
    const ctx = canvas.getContext('2d');

    if (video.readyState === 4 && ctx) {
      const start = performance.now();
      
      // ONLY Detect if model is loaded. If not, just skip (Camera still works!)
      if (this.model && !this.isAiLoading) {
        try {
          const predictions = await this.model.detect(video);
          
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.font = 'bold 16px Arial';
          ctx.textBaseline = 'top';

          predictions.forEach((prediction: any) => {
            const [x, y, width, height] = prediction.bbox;
            const label = `${prediction.class} ${Math.round(prediction.score * 100)}%`;

            // MIRROR FIX: Since video is scaleX(-1), we flip X coord
            const mirroredX = canvas.width - x - width;

            ctx.strokeStyle = '#00FF00';
            ctx.lineWidth = 4;
            ctx.strokeRect(mirroredX, y, width, height);

            const textWidth = ctx.measureText(label).width;
            ctx.fillStyle = '#00FF00';
            ctx.fillRect(mirroredX, y, textWidth + 10, 25);

            ctx.fillStyle = 'black';
            ctx.fillText(label, mirroredX + 5, y + 5);
          });
        } catch (err) {
          // Silent catch to prevent loop crash
        }
      }

      const end = performance.now();
      this.ngZone.run(() => {
        // Simple FPS calc
        const time = end - this.lastRun;
        if (time > 0) this.fps = Math.round(1000 / time);
      });
      this.lastRun = start;
    }

    requestAnimationFrame(() => this.detectLoop());
  }

  ngOnDestroy() { this.stopCamera(); }
}
